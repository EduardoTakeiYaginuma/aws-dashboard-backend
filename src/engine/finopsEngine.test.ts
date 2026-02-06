import {
  analyzeEC2Downsizing,
  analyzeEBSOrphaned,
  analyzeS3Lifecycle,
  analyzeRDSDownsizing,
  runFinOpsEngine,
} from './finopsEngine';
import {
  EC2Instance,
  CloudWatchMetric,
  EBSVolume,
  S3BucketInfo,
  RDSInstance,
} from '../aws/types';
import { createMockAwsClients } from '../aws/mockClients';
import prisma from '../db';

describe('FinOps Engine', () => {
  describe('analyzeEC2Downsizing', () => {
    it('should recommend downsizing for instances with CPU < 10%', () => {
      const instances: EC2Instance[] = [
        {
          instanceId: 'i-001',
          instanceType: 'm5.xlarge',
          state: 'running',
          launchTime: new Date('2024-01-01'),
          tags: { Name: 'low-cpu-server' },
          platform: 'linux',
        },
      ];
      const metrics: CloudWatchMetric[] = [
        { instanceId: 'i-001', averageCpuPercent: 4.5, maxCpuPercent: 15, periodDays: 14 },
      ];

      const results = analyzeEC2Downsizing(instances, metrics);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('EC2_DOWN_SIZE');
      expect(results[0].resourceId).toBe('i-001');
      expect(results[0].confidence).toBe('high'); // < 5%
      expect(results[0].estimatedMonthlySavings).toBeGreaterThan(0);
      expect(results[0].description).toContain('low-cpu-server');
      expect(results[0].description).toContain('4.5%');
    });

    it('should not recommend downsizing for instances with CPU >= 10%', () => {
      const instances: EC2Instance[] = [
        {
          instanceId: 'i-002',
          instanceType: 'c5.xlarge',
          state: 'running',
          launchTime: new Date('2024-01-01'),
          tags: { Name: 'busy-server' },
          platform: 'linux',
        },
      ];
      const metrics: CloudWatchMetric[] = [
        { instanceId: 'i-002', averageCpuPercent: 55.0, maxCpuPercent: 85, periodDays: 14 },
      ];

      const results = analyzeEC2Downsizing(instances, metrics);
      expect(results).toHaveLength(0);
    });

    it('should skip stopped instances', () => {
      const instances: EC2Instance[] = [
        {
          instanceId: 'i-003',
          instanceType: 'm5.xlarge',
          state: 'stopped',
          launchTime: new Date('2024-01-01'),
          tags: { Name: 'stopped-server' },
          platform: 'linux',
        },
      ];
      const metrics: CloudWatchMetric[] = [
        { instanceId: 'i-003', averageCpuPercent: 0, maxCpuPercent: 0, periodDays: 14 },
      ];

      const results = analyzeEC2Downsizing(instances, metrics);
      expect(results).toHaveLength(0);
    });

    it('should assign medium confidence for CPU between 5% and 10%', () => {
      const instances: EC2Instance[] = [
        {
          instanceId: 'i-004',
          instanceType: 'm5.xlarge',
          state: 'running',
          launchTime: new Date('2024-01-01'),
          tags: { Name: 'moderate-server' },
          platform: 'linux',
        },
      ];
      const metrics: CloudWatchMetric[] = [
        { instanceId: 'i-004', averageCpuPercent: 7.5, maxCpuPercent: 20, periodDays: 14 },
      ];

      const results = analyzeEC2Downsizing(instances, metrics);
      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe('medium');
    });

    it('should skip instances with less than 14 days of metrics', () => {
      const instances: EC2Instance[] = [
        {
          instanceId: 'i-005',
          instanceType: 'm5.xlarge',
          state: 'running',
          launchTime: new Date(),
          tags: { Name: 'new-server' },
          platform: 'linux',
        },
      ];
      const metrics: CloudWatchMetric[] = [
        { instanceId: 'i-005', averageCpuPercent: 2.0, maxCpuPercent: 5, periodDays: 7 },
      ];

      const results = analyzeEC2Downsizing(instances, metrics);
      expect(results).toHaveLength(0);
    });
  });

  describe('analyzeEBSOrphaned', () => {
    it('should recommend deletion for detached volumes > 7 days old', () => {
      const volumes: EBSVolume[] = [
        {
          volumeId: 'vol-001',
          size: 100,
          volumeType: 'gp3',
          state: 'available',
          attachments: [],
          createTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        },
      ];

      const results = analyzeEBSOrphaned(volumes);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('EBS_ORPHAN');
      expect(results[0].resourceId).toBe('vol-001');
      expect(results[0].confidence).toBe('high');
      // gp3 at 100 GiB: 100 * 0.08 = $8.00/mo
      expect(results[0].estimatedMonthlySavings).toBe(8.0);
    });

    it('should not flag attached volumes', () => {
      const volumes: EBSVolume[] = [
        {
          volumeId: 'vol-002',
          size: 100,
          volumeType: 'gp3',
          state: 'in-use',
          attachments: [{ instanceId: 'i-001', state: 'attached' }],
          createTime: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        },
      ];

      const results = analyzeEBSOrphaned(volumes);
      expect(results).toHaveLength(0);
    });

    it('should not flag recently created detached volumes', () => {
      const volumes: EBSVolume[] = [
        {
          volumeId: 'vol-003',
          size: 50,
          volumeType: 'gp2',
          state: 'available',
          attachments: [],
          createTime: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
        },
      ];

      const results = analyzeEBSOrphaned(volumes);
      expect(results).toHaveLength(0);
    });
  });

  describe('analyzeS3Lifecycle', () => {
    it('should recommend lifecycle for buckets inactive > 90 days in STANDARD', () => {
      const buckets: S3BucketInfo[] = [
        {
          bucketName: 'old-logs',
          region: 'us-east-1',
          sizeBytes: 1_000_000_000_000, // ~1 TB = 931 GiB ~ 953 GB (base 10 = 1000 GB)
          objectCount: 1_000_000,
          lastAccessedDays: 120,
          storageClass: 'STANDARD',
        },
      ];

      const results = analyzeS3Lifecycle(buckets);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('S3_LIFECYCLE');
      expect(results[0].resourceId).toBe('old-logs');
      expect(results[0].confidence).toBe('medium');
      expect(results[0].estimatedMonthlySavings).toBeGreaterThan(0);
    });

    it('should not flag recently accessed buckets', () => {
      const buckets: S3BucketInfo[] = [
        {
          bucketName: 'active-bucket',
          region: 'us-east-1',
          sizeBytes: 500_000_000_000,
          objectCount: 50_000,
          lastAccessedDays: 10,
          storageClass: 'STANDARD',
        },
      ];

      const results = analyzeS3Lifecycle(buckets);
      expect(results).toHaveLength(0);
    });

    it('should not flag buckets already in Glacier', () => {
      const buckets: S3BucketInfo[] = [
        {
          bucketName: 'archived-bucket',
          region: 'us-east-1',
          sizeBytes: 500_000_000_000,
          objectCount: 50_000,
          lastAccessedDays: 200,
          storageClass: 'GLACIER',
        },
      ];

      const results = analyzeS3Lifecycle(buckets);
      expect(results).toHaveLength(0);
    });
  });

  describe('analyzeRDSDownsizing', () => {
    it('should recommend downsizing for low-utilization RDS instances', () => {
      const instances: RDSInstance[] = [
        {
          dbInstanceId: 'dev-db',
          dbInstanceClass: 'db.r5.xlarge',
          engine: 'postgres',
          status: 'available',
          allocatedStorage: 200,
          averageCpuPercent: 3.0,
          averageConnections: 2,
          multiAZ: false,
        },
      ];

      const results = analyzeRDSDownsizing(instances);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('RDS_DOWN_SIZE');
      expect(results[0].resourceId).toBe('dev-db');
      expect(results[0].confidence).toBe('high'); // CPU < 5% and connections < 3
      expect(results[0].estimatedMonthlySavings).toBeGreaterThan(0);
    });

    it('should not recommend downsizing for well-utilized instances', () => {
      const instances: RDSInstance[] = [
        {
          dbInstanceId: 'prod-db',
          dbInstanceClass: 'db.r5.2xlarge',
          engine: 'postgres',
          status: 'available',
          allocatedStorage: 500,
          averageCpuPercent: 55.0,
          averageConnections: 120,
          multiAZ: true,
        },
      ];

      const results = analyzeRDSDownsizing(instances);
      expect(results).toHaveLength(0);
    });

    it('should mention Multi-AZ in description if enabled', () => {
      const instances: RDSInstance[] = [
        {
          dbInstanceId: 'staging-db',
          dbInstanceClass: 'db.r5.xlarge',
          engine: 'postgres',
          status: 'available',
          allocatedStorage: 200,
          averageCpuPercent: 8.0,
          averageConnections: 5,
          multiAZ: true,
        },
      ];

      const results = analyzeRDSDownsizing(instances);
      expect(results).toHaveLength(1);
      expect(results[0].description).toContain('Multi-AZ');
      expect(results[0].confidence).toBe('medium');
    });
  });

  describe('runFinOpsEngine (integration with mock clients)', () => {
    let testWorkspaceId: string;
    let testUserId: string;

    beforeAll(async () => {
        const user = await prisma.user.create({
            data: {
                id: 'dev-user-id-finops-test',
                email: 'test-finops@example.com',
                name: 'Test User Finops',
            },
        });
        testUserId = user.id;

        const workspace = await prisma.workspace.create({
            data: {
                id: 'test-workspace',
                name: 'Test Workspace for Engine',
                awsAccountId: '123456789012',
                roleArn: 'arn:aws:iam::123456789012:role/test-role',
                userId: testUserId,
            },
        });
        testWorkspaceId = workspace.id;
    });

    afterAll(async () => {
        await prisma.resource.deleteMany({ where: { workspaceId: testWorkspaceId } });
        await prisma.workspace.delete({ where: { id: testWorkspaceId } });
        await prisma.user.delete({ where: { id: testUserId } });
    });

    it('should return recommendations from all heuristics using mock data', async () => {
      const clients = createMockAwsClients('test-workspace');

      const results = await runFinOpsEngine(clients, 'test-workspace');

      expect(results.length).toBeGreaterThan(0);

      // Should have EC2 recommendations (instances with CPU < 10%)
      const ec2Recs = results.filter((r) => r.type === 'EC2_DOWN_SIZE');
      expect(ec2Recs.length).toBeGreaterThan(0);

      // Should have EBS recommendations (orphaned volumes)
      const ebsRecs = results.filter((r) => r.type === 'EBS_ORPHAN');
      expect(ebsRecs.length).toBeGreaterThan(0);

      // Should have S3 recommendations (inactive buckets)
      const s3Recs = results.filter((r) => r.type === 'S3_LIFECYCLE');
      expect(s3Recs.length).toBeGreaterThan(0);

      // Should have RDS recommendations (low-utilization instances)
      const rdsRecs = results.filter((r) => r.type === 'RDS_DOWN_SIZE');
      expect(rdsRecs.length).toBeGreaterThan(0);

      // All recommendations should have valid savings
      for (const rec of results) {
        expect(rec.estimatedMonthlySavings).toBeGreaterThan(0);
        expect(['low', 'medium', 'high']).toContain(rec.confidence);
      }
    });

    it('should produce deterministic results (seeded mock)', async () => {
      const clients1 = createMockAwsClients('workspace-a');
      const clients2 = createMockAwsClients('workspace-a');

      await runFinOpsEngine(clients1, 'test-workspace');
      const results1 = await prisma.resource.findMany({ where: { workspaceId: 'test-workspace' }, orderBy: { resourceId: 'asc' } });
      await prisma.resource.deleteMany({ where: { workspaceId: 'test-workspace' } });
      
      await runFinOpsEngine(clients2, 'test-workspace');
      const results2 = await prisma.resource.findMany({ where: { workspaceId: 'test-workspace' }, orderBy: { resourceId: 'asc' } });

      const cleanResults = (results: any[]) => results.map(r => {
        const { id, createdAt, updatedAt, lastSeenAt, ...rest } = r;
        return rest;
      });

      expect(cleanResults(results1)).toEqual(cleanResults(results2));
    });
  });
});
