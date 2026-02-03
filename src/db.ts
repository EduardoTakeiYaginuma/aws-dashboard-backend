import { PrismaClient, Prisma, Resource } from '@prisma/client';

const prisma = new PrismaClient();

export default prisma;
export { Prisma, Resource };
