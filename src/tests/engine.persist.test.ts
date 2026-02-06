import { runFinOpsEngine } from '../engine/finopsEngine';
import prisma, { Prisma, Resource } from '../db';
import { AwsClients } from '../aws/types';
import { createMockAwsClients } from '../aws/mockClients';

describe('FinOps Engine Persistence', () => {
    let workspaceId: string;
    let userId: string;

    beforeAll(async () => {
        const user = await prisma.user.create({
            data: {
                id: 'dev-user-id-engine',
                email: 'test-engine@example.com',
                name: 'Test User Engine',
            },
        });
        userId = user.id;

        const workspace = await prisma.workspace.create({
            data: {
                name: 'Test Engine Workspace',
                awsAccountId: '123456789012',
                roleArn: 'arn:aws:iam::123456789012:role/test-role',
                userId: userId,
            },
        });
        workspaceId = workspace.id;
    });

    afterAll(async () => {
        await prisma.resource.deleteMany({ where: { workspaceId } });
        await prisma.workspace.delete({ where: { id: workspaceId } });
        await prisma.user.delete({ where: { id: userId } });
        await prisma.$disconnect();
    });

    it('should persist resources with estimated monthly cost', async () => {
        const clients: AwsClients = createMockAwsClients(workspaceId);
        await runFinOpsEngine(clients, workspaceId);

        const resources = await prisma.resource.findMany({
            where: { workspaceId },
        });

        expect(resources.length).toBeGreaterThan(0);

        const ec2Instance = resources.find(
            (r: Resource) => r.resourceId === 'i-0a1b2c3d4e5f00004'
        );
        expect(ec2Instance).toBeDefined();
        expect(ec2Instance?.service).toBe('EC2');
        expect(ec2Instance?.type).toBe('t3.medium');
        expect(ec2Instance?.estimatedMonthlyCost).toBeCloseTo(0.0416 * 730);

        const ebsVolume = resources.find(
            (r: Resource) => r.resourceId === 'vol-0a1b2c3d4e5f00001'
        );
        expect(ebsVolume).toBeDefined();
        expect(ebsVolume?.service).toBe('EBS');
        expect(ebsVolume?.type).toBe('gp3');
        expect(ebsVolume?.estimatedMonthlyCost).toBeCloseTo(100 * 0.08);

        const s3Bucket = resources.find(
            (r: Resource) => r.resourceId === 'company-assets-cdn'
        );
        expect(s3Bucket).toBeDefined();
        expect(s3Bucket?.service).toBe('S3');
        expect(s3Bucket?.estimatedMonthlyCost).toBeGreaterThan(0);
    });
});
