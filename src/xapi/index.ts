export { XapiError } from './errors.js';
export { lrsAuthority } from './authority.js';
export { actorIfi, agentIfi } from './ifi.js';
export { ActorSchema, StatementSchema, VOIDED_VERB } from './schema.js';
export { etagFor, parseEtagHeader, type Preconditions } from './documents.js';
export { getActivity, getPerson, LOOKUP_SCAN_LIMIT } from './activities.js';
export {
  isMultipart,
  loadAttachments,
  parseStatementUpload,
  reconcileAttachments,
  saveAttachments,
  SIGNATURE_USAGE_TYPE,
  statementResponse,
  type AttachmentBody,
  type StatementUpload,
} from './attachments.js';
export { buildMultipart, parseMultipart, type MultipartPart } from './multipart.js';
export {
  getStatement,
  MAX_PAGE_SIZE,
  queryStatements,
  storeStatements,
  XAPI_VERSION,
  type StatementPage,
  type StatementQuery,
  type StoreStatementsResult,
} from './statements.js';
export {
  deleteState,
  deleteStates,
  getState,
  listStateIds,
  postState,
  putState,
  type StateDocument,
  type StateKey,
} from './state.js';
export {
  deleteProfile,
  getProfile,
  listProfileIds,
  postProfile,
  putProfile,
  type ProfileDocument,
  type ProfileKey,
  type ProfileOwner,
  type ProfileScope,
} from './profile.js';
export type {
  Activity,
  Actor,
  Agent,
  Context,
  Group,
  Result,
  Statement,
  StatementFormat,
  StatementObject,
  StatementRef,
  StatementResult,
  SubStatement,
  Verb,
} from './types.js';
