import { afterAll } from "bun:test";
import "./env";
import { teardownInfra } from "./infra";

afterAll(async () => {
  await teardownInfra();
});
