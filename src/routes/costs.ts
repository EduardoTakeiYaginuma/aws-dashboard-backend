import { FastifyInstance } from 'fastify';
import { getCostsSummaryHandler } from '../controllers/costsController';
import { authMiddleware } from '../middleware/auth';

export async function costsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/costs/summary',
    {
      preHandler: authMiddleware,
      schema: {
        querystring: {
          type: 'object',
          required: ['workspaceId'],
          properties: {
            workspaceId: { type: 'string' },
            period: { type: 'string' },
          },
        } as const,
      },
    },
    getCostsSummaryHandler
  );
}
