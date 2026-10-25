import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { DomainError } from "../../domain/domain-error";
import { describeError, describeUnexpectedError } from "../observability/log-safe-error";
import { isTransientInfrastructureError } from "../persistence/transient-error";

const STATUS_BY_CODE: Record<string, HttpStatus> = {
  INVALID_MONEY: HttpStatus.BAD_REQUEST,
  INVALID_PAYLOAD: HttpStatus.BAD_REQUEST,
  KIND_NOT_ALLOWED: HttpStatus.BAD_REQUEST,
  REFERENCE_REQUIRED: HttpStatus.BAD_REQUEST,
  CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
  WAGER_TRANSACTION_NOT_FOUND: HttpStatus.NOT_FOUND,
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
      response.status(status).json({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (isTransientInfrastructureError(exception)) {
      this.logger.warn("falha transitória", describeError(exception));
      response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ code: "TRANSIENT_FAILURE", message: "falha temporária, tente novamente" });
      return;
    }

    this.logger.error("erro inesperado", describeUnexpectedError(exception));
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ code: "INTERNAL_ERROR", message: "erro interno" });
  }
}
