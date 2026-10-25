#!/bin/bash
set -euo pipefail

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true,MessageRetentionPeriod=1209600
DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"VisibilityTimeout\": \"30\",
  \"MessageRetentionPeriod\": \"345600\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}\"
}"

awslocal sqs create-queue --queue-name wagering-events.fifo --attributes FifoQueue=true
