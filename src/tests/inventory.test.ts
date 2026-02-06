import Fastify, { FastifyInstance } from 'fastify';
import { inventoryRoutes } from '../routes/inventory';
import prisma, { Resource } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('GET /api/inventory', () => {
    let app: FastifyInstance;
    let workspaceId: string;
    let userId: string;

    beforeAll(async () => {
        app = Fastify();
        app.addHook('preHandler', authMiddleware);
        await app.register(inventoryRoutes);
        await app.ready();
        
        const user = await prisma.user.create({
            data: {
                id: 'dev-user-id-inventory',
                email: 'test-inventory@example.com',
                name: 'Test User',
            },
            
        });
        userId = user.id;

        const workspace = await prisma.workspace.create({
            data: {
                name: 'Test Workspace',
                awsAccountId: '123456789012',
                roleArn: 'arn:aws:iam::123456789012:role/test-role',
                userId: userId,
            },
        });
        workspaceId = workspace.id;

        await prisma.resource.createMany({
            data: [
                {
                    workspaceId,
                    resourceId: 'i-1234567890abcdef0',
                    service: 'EC2',
                    type: 't3.micro',
                    name: 'test-instance-1',
                    tags: { "owner": "teamA" },
                    state: 'running',
                    estimatedMonthlyCost: 10.0,
                },
                {
                    workspaceId,
                    resourceId: 'vol-0123456789abcdef0',
                    service: 'EBS',
                    type: 'gp2',
                    name: 'test-volume-1',
                    tags: { "owner": "teamB" },
                    state: 'in-use',
                    estimatedMonthlyCost: 5.0,
                },
                {
                    workspaceId,
                    resourceId: 'i-abcdef01234567890',
                    service: 'EC2',
                    type: 't3.large',
                    name: 'another-instance',
                    tags: { "owner": "teamA" },
                    state: 'stopped',
                    estimatedMonthlyCost: 0.0,
                },
            ],
        });
    });

    afterAll(async () => {
        await prisma.resource.deleteMany({ where: { workspaceId } });
        await prisma.workspace.delete({ where: { id: workspaceId } });
        await prisma.user.delete({ where: { id: userId } });
        await app.close();
        await prisma.$disconnect();
    });

    it('should return a paginated list of resources for a workspace', async () => {
        const response = await app.inject({
            method: 'GET',
            url: `/api/inventory?workspaceId=${workspaceId}`,
            headers: {
                authorization: 'Bearer dev-token',
            }
        });

        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.items.length).toBe(3);
        expect(payload.total).toBe(3);
        expect(payload.page).toBe(1);
        expect(payload.perPage).toBe(20);
    });

    it('should filter resources by service', async () => {
        const response = await app.inject({
            method: 'GET',
            url: `/api/inventory?workspaceId=${workspaceId}&service=EBS`,
            headers: {
                authorization: 'Bearer dev-token',
            }
        });

        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.items.length).toBe(1);
        expect(payload.total).toBe(1);
        expect(payload.items[0].service).toBe('EBS');
    });

    it('should filter resources by tag', async () => {
        const response = await app.inject({
            method: 'GET',
            url: `/api/inventory?workspaceId=${workspaceId}&tag=owner:teamA`,
            headers: {
                authorization: 'Bearer dev-token',
            }
        });

        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.items.length).toBe(2);
        expect(payload.total).toBe(2);
    });

    it('should perform a text search on resourceId and name', async () => {
        const response = await app.inject({
            method: 'GET',
            url: `/api/inventory?workspaceId=${workspaceId}&q=another`,
            headers: {
                authorization: 'Bearer dev-token',
            }
        });

        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.items.length).toBe(1);
        expect(payload.total).toBe(1);
        expect(payload.items[0].name).toBe('another-instance');
    });

    it('should handle pagination correctly', async () => {
        const response = await app.inject({
            method: 'GET',
            url: `/api/inventory?workspaceId=${workspaceId}&page=2&perPage=2`,
            headers: {
                authorization: 'Bearer dev-token',
            }
        });

        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.items.length).toBe(1);
        expect(payload.total).toBe(3);
        expect(payload.page).toBe(2);
        expect(payload.perPage).toBe(2);
    });
});
