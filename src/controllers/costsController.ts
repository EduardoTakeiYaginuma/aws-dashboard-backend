import { FastifyRequest, FastifyReply } from 'fastify';
import { getCostsSummary } from '../services/costsService';

export async function getCostsSummaryHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { workspaceId, period } = request.query as { workspaceId: string, period?: string };

  const result = await getCostsSummary({
    workspaceId,
    period,
  });

  return reply.send(result);
}
