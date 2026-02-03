import { Prisma } from '@prisma/client';
import prisma from '../db';

interface GetInventoryParams {
  workspaceId: string;
  service?: string;
  tag?: string;
  q?: string;
  page: number;
  perPage: number;
}

export async function getInventory(params: GetInventoryParams) {
  const { workspaceId, service, tag, q, page, perPage } = params;

  const where: Prisma.ResourceWhereInput = {
    workspaceId,
  };

  if (service) {
    where.service = service;
  }

  if (q) {
    where.OR = [
      { resourceId: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
    ];
  }

  if (tag) {
    const [key, value] = tag.split(':');
    if (key && value) {
      where.tags = {
        path: [key],
        equals: value,
      };
    }
  }

  const total = await prisma.resource.count({ where });
  const items = await prisma.resource.findMany({
    where,
    skip: (page - 1) * perPage,
    take: perPage,
    orderBy: {
      lastSeenAt: 'desc',
    },
  });

  return {
    items,
    total,
    page,
    perPage,
  };
}
