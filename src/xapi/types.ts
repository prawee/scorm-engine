export type {
  Activity,
  Actor,
  Agent,
  Context,
  Group,
  Result,
  Statement,
  StatementObject,
  StatementRef,
  SubStatement,
  Verb,
} from './schema.js';

/** How much of each statement a Statement query returns. */
export type StatementFormat = 'ids' | 'exact' | 'canonical';

/** The xAPI StatementResult envelope. */
export interface StatementResult {
  statements: unknown[];
  more: string;
}
