# Decisões de arquitetura

O enunciado já entregava muita coisa pronta: classes de domínio, eventos, endpoints, filas, regras. Isso eu só implementei. O que vale contar é o que ele deixou em branco e eu tive que resolver.

## Organização do código

Fui na arquitetura hexagonal, mais pela flexibilidade mesmo. O desafio já começa com duas portas de entrada pra mesma regra (HTTP e SQS), e eu queria que as duas caíssem exatamente no mesmo caso de uso, sem ele saber de onde veio a chamada.

O domínio não conhece Nest nem MikroORM. Repositório e outbox são portas (classe abstrata, que de quebra serve de token de injeção no Nest), e controller, consumer, workers e banco ficam do lado de fora.

Separei também a entidade de banco da entidade de domínio. Dá um pouco mais de código, já que o repositório converte uma na outra, mas o domínio fica limpo e o `Money` não precisou virar embeddable do ORM. Não ficou 100% purista: os casos de uso usam o `@Injectable()` do Nest. Preferi assim a montar injeção na mão.

## ORM, dinheiro e transação

Fui de MikroORM, que era o preferido do enunciado e encaixou bem no problema. Ele tem Unit of Work, então tudo que muda numa transação vai pro banco junto no final. Tem Identity Map, então a wallet que eu leio é o mesmo objeto que eu salvo. E tem `transactional()` e `LockMode` prontos, que usei pro lock da wallet e pro `SKIP LOCKED` dos workers.

Dinheiro nunca passa por `number`. No domínio, o `Money` usa `decimal.js` por dentro. No banco, o valor fica numa coluna `numeric(19,2)` e a moeda numa coluna separada. O driver do Postgres devolve `numeric` como string, e essa string vira `Money` direto. Na entrada só aceito string com 2 casas decimais, nada de `25`, `25.5`, notação científica ou negativo.

Quem abre a transação é o adaptador (o controller, o consumer ou o worker), através de um `TransactionRunner`. O caso de uso não abre transação, só participa da que já está aberta. É isso que deixa a inbox ou a chave de idempotência, a transação, o saldo, o ledger e a outbox caírem no mesmo commit. Ou vai tudo, ou não vai nada.

## Estados da transação

Uma transação nasce `PENDING` e, no mesmo commit, já vai pra um destes:

- `PROCESSED`: aplicou;
- `REJECTED`: regra de negócio recusou;
- `PENDING_REFERENCE`: é reversão e a referência ainda não chegou.

De `PENDING_REFERENCE` ela só sai pra `PROCESSED` (a referência chegou) ou `REJECTED` (desistiu). `PROCESSED`, `REJECTED` e `FAILED` são finais. Tentar mudar uma transação finalizada lança erro, porque isso é bug, não regra de negócio. Na prática, `PENDING` nunca chega a ser gravado no banco.

## Idempotência no HTTP

Foi a parte em que eu mais pensei. O enunciado pede que a `Idempotency-Key` seja a fonte da verdade e que requisição repetida devolva a mesma resposta, mas não fala como fazer.

Criei uma tabela de idempotência no Postgres só pra entrada HTTP, como uma camada a mais na frente do processamento. Chegou requisição, a primeira coisa é olhar essa tabela:

- se a chave já está lá com o mesmo payload, devolvo a resposta salva e acabou: nem chega no processamento, nem precisa ir conferir na tabela de transações, que é a que mais cresce;
- se a chave está lá com outro payload, é `409`;
- se não está, gravo a chave na mesma transação do processamento e salvo a resposta no final.

A base foi o artigo do Brandur sobre como a Stripe faz isso no Postgres, mas simplifiquei bastante. Lá a requisição chama serviço externo no meio do caminho, então ele precisa quebrar o fluxo em fases e lembrar onde parou (`recovery_point`, `locked_at`, `last_run_at`). Aqui não tem isso: tudo que importa está no mesmo banco, e o único efeito externo (publicar evento) já sai pela outbox. Virou uma transação só, e esses campos não fizeram falta. Fiquei com `provider_id` no lugar do usuário, o hash do payload e a resposta.

O hash é um SHA-256 de um JSON "canônico": chaves ordenadas em todos os níveis e campos ausentes removidos, então a ordem em que os campos chegam não muda o resultado. Só entram os campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. Header e coisas de transporte ficam de fora.

Pra duas requisições iguais chegando juntas não precisei de lock nenhum. A segunda fica esperando no índice único até a primeira terminar. Se a primeira commita, a segunda bate na unicidade, tenta de novo e volta como replay.

Só que essa tabela cresce a cada requisição, então coloquei uma limpeza. Um worker roda quando a aplicação sobe e depois de **1 em 1 hora**, e apaga as chaves com mais de **24 horas**, em lotes de 1.000 linhas pra não segurar lock. Pode rodar em todas as instâncias ao mesmo tempo, que uma não pega a linha da outra.

E apagar não abre brecha pra cobrar duas vezes. A tabela de transações tem `UNIQUE` na idempotency key e no par `providerId + externalTransactionId`. Se o provedor reenviar depois das 24 horas, passa pela tabela de idempotência mas é barrado na de transações e volta como replay, sem débito novo. A tabela de idempotência é o atalho; quem garante de verdade é a de transações.

## Idempotência na fila

Mesma ideia, usando a inbox que o enunciado já pedia: cada mensagem processada fica registrada pelo `messageId`, e mensagem repetida só ganha ack. A inbox entra na mesma limpeza, com prazo maior: apaga o que tem mais de **7 dias (168 horas)**. A fila só guarda uma mensagem por 4 dias, então depois disso não tem mais o que proteger. E se alguma mensagem velha voltar (reprocessada da DLQ, por exemplo), a tabela de transações barra do mesmo jeito.

## Saldo no replay

A regra 7 quer que o replay devolva o saldo daquele momento. Pra quem mexe no saldo dava pra tirar do ledger, mas LOSS e transação rejeitada não geram lançamento. Resolvi guardando o saldo numa coluna da própria transação, quando ela termina.

## Concorrência

Comecei só com lock otimista, pela `version` da wallet. Funcionava, mas com várias instâncias brigando pela mesma wallet, parte das requisições estourava as tentativas e voltava `503`. Mudei pra travar a linha da wallet (`SELECT ... FOR UPDATE`) antes de mexer no saldo, e deixei a `version` como proteção extra. Agora quem chega depois espera e já lê o saldo atualizado.

Cada transação trava uma wallet só, então wallets diferentes seguem em paralelo. O que ainda pode dar conflito (duas inserções da mesma chave, deadlock) é refeito até 5 vezes, com uma esperinha aleatória entre uma tentativa e outra.

## Reversão chegando antes da aposta

Se um REFUND ou ROLLBACK chega antes da aposta, ele fica salvo como `PENDING_REFERENCE` e um worker tenta de novo depois. O controle das tentativas fica na própria linha da transação, e o worker pega as pendentes com `SKIP LOCKED`, pras instâncias não brigarem pela mesma.

São até 10 tentativas, esperando 1 s, 2 s, 4 s… até no máximo 5 minutos, uns 13 minutos no total. Escolhi pra bater com o tempo que uma mensagem fica tentando na fila antes de ir pra DLQ. Assim, se a aposta estiver travada na fila por alguma falha temporária, ela ainda chega antes de a reversão desistir. Se não chegar, a reversão é rejeitada com `REFERENCE_NOT_FOUND`.

## REFUND e ROLLBACK da mesma aposta

O enunciado diz que uma referência não pode ser revertida duas vezes "pelo mesmo tipo de operação". Ao pé da letra, uma aposta poderia levar um REFUND **e** um ROLLBACK, e o jogador ganharia o dinheiro de volta duas vezes. Como o próprio enunciado proíbe crédito duplicado, fechei em uma reversão por aposta, seja de que tipo for. Desfazer um REFUND continua valendo, porque aí o ROLLBACK aponta pro REFUND, não pra aposta. Isso está no código e num índice único no banco.

## Erros e status HTTP

Os códigos de falha e os status também ficaram comigo. O código de falha é o mesmo do erro de domínio, pro provedor decidir olhando o código e não a mensagem. Ficaram estes:

- `INSUFFICIENT_FUNDS`: aposta maior que o saldo. Não adianta reenviar.
- `REVERSAL_WOULD_OVERDRAFT`: a reversão deixaria o saldo negativo. É diferente do anterior de propósito, porque é um caso pra alguém olhar na mão.
- `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `REVERSAL_AMOUNT_MISMATCH`: tem algo errado no payload (moeda, dono da wallet, referência de outra rodada, tipo que não pode ser revertido, valor diferente). O provedor corrige e manda de novo.
- `REFERENCE_NOT_PROCESSED`: a referência existe, mas foi rejeitada, então não tem o que reverter.
- `REFERENCE_ALREADY_REVERSED`: a referência já foi revertida.
- `REFERENCE_NOT_FOUND`: a referência não chegou dentro do limite de tentativas.
- `INFRASTRUCTURE_FAILURE`: reservado pro `FAILED`, que hoje ninguém usa (explico no fim).

E os status:

- `200`: processou;
- `202`: aceitou, mas tá esperando a referência;
- `400`: payload errado;
- `404`: wallet ou transação não existe;
- `409`: chave repetida com outro payload, ou wallet duplicada;
- `422`: regra de negócio recusou (e fica registrado);
- `503`: falha temporária, pode reenviar com a mesma chave.

Um detalhe que só peguei derrubando o Postgres nos testes: o MikroORM não transforma a queda do banco num erro de conexão próprio. Chegava um erro genérico, e a API devolvia `500` em vez de `503`. Passei a olhar o código do erro (SQLSTATE e erro de rede) pra classificar direito.

## Fila e outbox

O consumer só faz ack depois do commit. Erro de regra de negócio ganha ack, porque tentar de novo daria no mesmo. Payload inválido vai pra DLQ. Erro temporário volta pra fila com espera crescente, e a mensagem tem até 10 entregas antes da DLQ (uns 13 minutos), pra uma queda rápida do banco não jogar mensagem boa lá.

No desligamento descobri, testando, que abortar o long polling dava problema: o SQS ainda mandava a próxima mensagem pra conexão que já tinha morrido, e ela ficava presa gastando tentativa. Agora o consumer espera o polling voltar e devolve o que vier.

Os eventos saem pela outbox pra uma fila FIFO, com o id do evento como id de deduplicação. Se uma instância publica e morre antes de marcar como enviado, outra publica de novo e o SQS descarta a repetida. A outbox não tem limite de tentativas: evento de coisa que já foi confirmada não pode sumir.

## O que ficou de fora

Autenticação eu não fiz, e o enunciado deixa. Tem um guard que hoje libera tudo, justamente no lugar onde entraria a validação de um token OIDC (Keycloak ou Zitadel), conferindo se o `providerId` do payload é o do token.

O status `FAILED` existe, mas nenhum fluxo chega nele: erro permanente acontece antes de a transação existir (vai pra DLQ), e erro no meio do processamento desfaz tudo e tenta de novo. Ele faria sentido se tivesse alguma chamada externa no meio do caminho.

Com a wallet travada, uma wallet muito disputada fica mais lenta, porque as escritas nela entram em fila. Preferi isso a devolver erro.

Os opcionais (ledger de partidas dobradas, OpenTelemetry, dashboard) eu acabei não fazendo por causa do tempo. Preferi gastar o que eu tinha deixando a parte obrigatória bem feita e testada.

O teste de carga também ficou de fora, mas por limitação do meu ambiente. Durante os testes a memória da minha máquina entrava em swap, a CPU do SQS no LocalStack ficava sempre no limite, e isso acabava quebrando o projeto e derrubando o Docker. Como os números não iam refletir o sistema, só a minha máquina sofrendo, achei mais honesto não entregar.

Também tinha outras arquiteturas que eu queria testar, mas pelo tempo fui no básico bem feito. Sem teste de carga confiável para comparar uma com a outra, não fazia sentido trocar no escuro, então mantive essa, que está validada pelos testes.

## Como eu trabalhei

Tentei dar o meu melhor. Usei o Claude Code para escrever o código e revisar os textos. Durante a revisão, fui corrigindo várias coisas que a IA fez errado ou que não atendiam ao que eu tinha pedido. As decisões deste documento são minhas; a IA me ajudou a chegar mais rápido no código e a encontrar alguns bugs nos testes.

Nas tecnologias fui pela documentação oficial do Nest, do MikroORM, do Postgres e do SQS. Pra parte de transação, idempotência e mensageria, o que mais me ajudou foi o *Designing Data-Intensive Applications*, do Kleppmann, e o artigo do Brandur.
