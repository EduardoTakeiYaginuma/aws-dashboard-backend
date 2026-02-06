import { FastifyRequest, FastifyReply } from 'fastify';
import { getInventory } from '../services/inventoryService';

export async function getInventoryHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { workspaceId, service, tag, q, page: pageStr, perPage: perPageStr } = request.query as { workspaceId: string, service?: string, tag?: string, q?: string, page?: string, perPage?: string };
  const page = parseInt(pageStr || '1', 10);
  const perPage = parseInt(perPageStr || '20', 10);

  const result = await getInventory({
    workspaceId,
    service,
    tag,
    q,
    page: Math.max(1, page),
    perPage: Math.min(100, Math.max(1, perPage)),
  });

  return reply.send(result);
}
