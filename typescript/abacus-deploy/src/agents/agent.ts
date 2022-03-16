export abstract class AgentKey {
  abstract get identifier(): string;
  abstract get address(): string;
  abstract get credentialsAsHelmValue(): any;

  abstract fetch(): Promise<void>;
}
