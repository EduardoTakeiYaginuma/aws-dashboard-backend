import { FastifyInstance } from 'fastify';
import { getInventoryHandler } from '../controllers/inventoryController';
import { authMiddleware } from '../middleware/auth';

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/inventory',
    {
      preHandler: authMiddleware,
      schema: {
        querystring: {
          type: 'object',
          required: ['workspaceId'],
          properties: {
            workspaceId: { type: 'string' },
            service: { type: 'string' },
            tag: { type: 'string' },
            q: { type: 'string' },
            page: { type: 'string' },
            perPage: { type: 'string' },
          },
        } as const,
      },
    },
    getInventoryHandler
  );
}
