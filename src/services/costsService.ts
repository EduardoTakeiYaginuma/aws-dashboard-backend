import { Prisma } from '@prisma/client';
import prisma from '../db';

interface GetCostsSummaryParams {
  workspaceId: string;
  period?: string; // for now, only 30d is supported
}

export async function getCostsSummary(params: GetCostsSummaryParams) {
  const { workspaceId } = params;

  // 1. Calculate total cost and cost by service
  const serviceAggregation = await prisma.resource.groupBy({
    by: ['service'],
    where: { workspaceId },
    _sum: {
      estimatedMonthlyCost: true,
    },
  });

  const total = serviceAggregation.reduce(
    (acc, item) => acc + (item._sum.estimatedMonthlyCost || 0),
    0
  );

  const byService = serviceAggregation.map((item) => ({
    service: item.service,
    cost: item._sum.estimatedMonthlyCost || 0,
  }));

  // 2. Calculate cost by tag (owner tag)
  const resourcesWithTags = await prisma.resource.findMany({
    where: {
      workspaceId,
      tags: {
        not: Prisma.JsonNull,
      },
      estimatedMonthlyCost: {
        gt: 0,
      },
    },
    select: {
      tags: true,
      estimatedMonthlyCost: true,
    },
  });

  const byTag: Record<string, number> = {};
  for (const resource of resourcesWithTags) {
    const tags = resource.tags as Record<string, string>;
    const ownerTag = Object.entries(tags).find(([key]) =>
      key.toLowerCase() === 'owner'
    )?.[1];
    
    if (ownerTag) {
        const key = `owner:${ownerTag}`;
        if (!byTag[key]) {
            byTag[key] = 0;
        }
        byTag[key] += resource.estimatedMonthlyCost || 0;
    }
  }

  const byTagArray = Object.entries(byTag)
    .map(([tag, cost]) => ({
      tag,
      cost,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);

  return {
    total,
    byService,
    byTag: byTagArray,
  };
}
