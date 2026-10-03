import type { Actor } from './types.js';

/** The LRS stamps itself as the authority, naming the tenant the write belongs to. */
export function lrsAuthority(tenantId: string, homePage: string): Actor {
  return {
    objectType: 'Agent',
    name: 'ScormFlow LRS',
    account: { homePage, name: tenantId },
  };
}
