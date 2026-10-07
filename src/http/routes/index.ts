import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { ENGINE_VERSION } from '../../version.js';

export const registerRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/', async () => ({ name: '@scormflow/server', version: ENGINE_VERSION }));
};
