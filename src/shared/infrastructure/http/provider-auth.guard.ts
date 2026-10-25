import { type CanActivate, Injectable } from "@nestjs/common";

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
