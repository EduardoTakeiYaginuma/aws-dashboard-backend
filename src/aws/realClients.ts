import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeNatGatewaysCommand,
  DescribeAddressesCommand,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetBucketLocationCommand,
} from '@aws-sdk/client-s3';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { Credentials } from '@aws-sdk/types';
import {
  AwsClients,
  EC2Instance,
  CloudWatchMetric,
  EBSVolume,
  S3BucketInfo,
  RDSInstance,
  CostData,
  LambdaFunction,
  LoadBalancerInfo,
  NatGatewayInfo,
  ElasticIPInfo,
} from './types';

const DEFAULT_REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * Assume an IAM Role via STS and return temporary credentials.
 */
async function assumeRole(roleArn: string, sessionName: string): Promise<Credentials> {
  const sts = new STSClient({ region: DEFAULT_REGION });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: 3600,
    })
  );

  if (!result.Credentials) {
    throw new Error('AssumeRole did not return credentials');
  }

  return {
    accessKeyId: result.Credentials.AccessKeyId!,
    secretAccessKey: result.Credentials.SecretAccessKey!,
    sessionToken: result.Credentials.SessionToken!,
    expiration: result.Credentials.Expiration,
  };
}

export function createRealAwsClients(
  roleArn: string,
  _awsAccountId: string
): AwsClients {
  let credentialsPromise: Promise<Credentials> | null = null;

  function getCredentials(): Promise<Credentials> {
    if (!credentialsPromise) {
      credentialsPromise = assumeRole(roleArn, 'finops-dashboard');
    }
    return credentialsPromise;
  }

  async function getEC2Client(): Promise<EC2Client> {
    const creds = await getCredentials();
    return new EC2Client({ region: DEFAULT_REGION, credentials: creds });
  }

  async function getCloudWatchClient(): Promise<CloudWatchClient> {
    const creds = await getCredentials();
    return new CloudWatchClient({ region: DEFAULT_REGION, credentials: creds });
  }

  async function getS3Client(): Promise<S3Client> {
    const creds = await getCredentials();
    return new S3Client({ region: DEFAULT_REGION, credentials: creds });
  }

  async function getRDSClient(): Promise<RDSClient> {
    const creds = await getCredentials();
    return new RDSClient({ region: DEFAULT_REGION, credentials: creds });
  }

  async function getCostExplorerClient(): Promise<CostExplorerClient> {
    const creds = await getCredentials();
    return new CostExplorerClient({ region: DEFAULT_REGION, credentials: creds });
  }

  async function getLambdaClient(): Promise<LambdaClient> {
    const creds = await getCredentials();
    return new LambdaClient({ region: DEFAULT_REGION, credentials: creds });
  }

  async function getELBv2Client(): Promise<ElasticLoadBalancingV2Client> {
    const creds = await getCredentials();
    return new ElasticLoadBalancingV2Client({ region: DEFAULT_REGION, credentials: creds });
  }

  return {
    async testConnection(): Promise<boolean> {
      await getCredentials();
      return true;
    },

    async listEC2Instances(): Promise<EC2Instance[]> {
      const ec2 = await getEC2Client();
      const instances: EC2Instance[] = [];
      let nextToken: string | undefined;

      do {
        const res = await ec2.send(
          new DescribeInstancesCommand({ NextToken: nextToken })
        );
        for (const reservation of res.Reservations || []) {
          for (const inst of reservation.Instances || []) {
            if (!inst.InstanceId) continue;
            const tags: Record<string, string> = {};
            for (const tag of inst.Tags || []) {
              if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
            }
            instances.push({
              instanceId: inst.InstanceId,
              instanceType: inst.InstanceType || 'unknown',
              state: inst.State?.Name || 'unknown',
              launchTime: inst.LaunchTime || new Date(),
              tags,
              platform: inst.Platform || 'linux',
            });
          }
        }
        nextToken = res.NextToken;
      } while (nextToken);

      return instances;
    },

    async getEC2CpuMetrics(instanceIds: string[]): Promise<CloudWatchMetric[]> {
      if (instanceIds.length === 0) return [];

      const cw = await getCloudWatchClient();
      const now = new Date();
      const startTime = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const metrics: CloudWatchMetric[] = [];

      // Process in batches of 10 (CloudWatch GetMetricData limit per query is 500,
      // but we do 2 queries per instance: avg and max)
      const batchSize = 10;
      for (let i = 0; i < instanceIds.length; i += batchSize) {
        const batch = instanceIds.slice(i, i + batchSize);
        const metricQueries = batch.flatMap((id, idx) => [
          {
            Id: `avg_${idx}`,
            MetricStat: {
              Metric: {
                Namespace: 'AWS/EC2',
                MetricName: 'CPUUtilization',
                Dimensions: [{ Name: 'InstanceId', Value: id }],
              },
              Period: 14 * 24 * 3600, // entire 14-day period as one point
              Stat: 'Average',
            },
          },
          {
            Id: `max_${idx}`,
            MetricStat: {
              Metric: {
                Namespace: 'AWS/EC2',
                MetricName: 'CPUUtilization',
                Dimensions: [{ Name: 'InstanceId', Value: id }],
              },
              Period: 14 * 24 * 3600,
              Stat: 'Maximum',
            },
          },
        ]);

        const res = await cw.send(
          new GetMetricDataCommand({
            StartTime: startTime,
            EndTime: now,
            MetricDataQueries: metricQueries,
          })
        );

        for (let idx = 0; idx < batch.length; idx++) {
          const avgResult = res.MetricDataResults?.find((r) => r.Id === `avg_${idx}`);
          const maxResult = res.MetricDataResults?.find((r) => r.Id === `max_${idx}`);

          const avgValues = avgResult?.Values || [];
          const maxValues = maxResult?.Values || [];

          const averageCpu = avgValues.length > 0
            ? avgValues.reduce((a, b) => a + b, 0) / avgValues.length
            : 0;
          const maxCpu = maxValues.length > 0 ? Math.max(...maxValues) : 0;

          metrics.push({
            instanceId: batch[idx],
            averageCpuPercent: Math.round(averageCpu * 100) / 100,
            maxCpuPercent: Math.round(maxCpu * 100) / 100,
            periodDays: 14,
          });
        }
      }

      return metrics;
    },

    async listEBSVolumes(): Promise<EBSVolume[]> {
      const ec2 = await getEC2Client();
      const volumes: EBSVolume[] = [];
      let nextToken: string | undefined;

      do {
        const res = await ec2.send(
          new DescribeVolumesCommand({ NextToken: nextToken })
        );
        for (const vol of res.Volumes || []) {
          if (!vol.VolumeId) continue;
          volumes.push({
            volumeId: vol.VolumeId,
            size: vol.Size || 0,
            volumeType: vol.VolumeType || 'gp2',
            state: vol.State || 'unknown',
            attachments: (vol.Attachments || []).map((a) => ({
              instanceId: a.InstanceId || '',
              state: a.State || 'unknown',
            })),
            createTime: vol.CreateTime || new Date(),
          });
        }
        nextToken = res.NextToken;
      } while (nextToken);

      return volumes;
    },

    async listS3Buckets(): Promise<S3BucketInfo[]> {
      const s3 = await getS3Client();
      const res = await s3.send(new ListBucketsCommand({}));
      const buckets: S3BucketInfo[] = [];

      for (const bucket of res.Buckets || []) {
        if (!bucket.Name) continue;

        // Get bucket region
        let region = DEFAULT_REGION;
        try {
          const locRes = await s3.send(
            new GetBucketLocationCommand({ Bucket: bucket.Name })
          );
          region = locRes.LocationConstraint || 'us-east-1';
        } catch {
          // Use default region if we can't determine location
        }

        // Sample objects to estimate size and last access
        // We use a small sample to avoid slow/expensive ListObjects on large buckets
        let sizeBytes = 0;
        let objectCount = 0;
        let oldestLastModifiedDays = 0;
        let storageClass = 'STANDARD';

        try {
          const regionS3 = new S3Client({
            region,
            credentials: await getCredentials(),
          });
          const objRes = await regionS3.send(
            new ListObjectsV2Command({
              Bucket: bucket.Name,
              MaxKeys: 100,
            })
          );

          objectCount = objRes.KeyCount || 0;
          const now = new Date();

          for (const obj of objRes.Contents || []) {
            sizeBytes += obj.Size || 0;
            if (obj.StorageClass) storageClass = obj.StorageClass;
            if (obj.LastModified) {
              const days = Math.floor(
                (now.getTime() - obj.LastModified.getTime()) / (1000 * 60 * 60 * 24)
              );
              if (days > oldestLastModifiedDays) oldestLastModifiedDays = days;
            }
          }

          // Extrapolate: if the bucket reports more objects, scale size estimate
          if (objRes.IsTruncated && objectCount > 0) {
            // Use NumberOfObjects from CloudWatch for better estimate if available,
            // otherwise rough extrapolate assuming uniform size distribution
            // For MVP, just note that this is a sample
          }
        } catch {
          // Skip buckets we can't access (permissions, region issues)
          continue;
        }

        buckets.push({
          bucketName: bucket.Name,
          region,
          sizeBytes,
          objectCount,
          lastAccessedDays: oldestLastModifiedDays,
          storageClass,
        });
      }

      return buckets;
    },

    async listRDSInstances(): Promise<RDSInstance[]> {
      const rds = await getRDSClient();
      const cw = await getCloudWatchClient();
      const instances: RDSInstance[] = [];
      let marker: string | undefined;

      do {
        const res = await rds.send(
          new DescribeDBInstancesCommand({ Marker: marker })
        );

        for (const db of res.DBInstances || []) {
          if (!db.DBInstanceIdentifier) continue;

          // Get CPU and connection metrics from CloudWatch (last 14 days)
          let avgCpu = 0;
          let avgConnections = 0;

          try {
            const now = new Date();
            const startTime = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

            const metricsRes = await cw.send(
              new GetMetricDataCommand({
                StartTime: startTime,
                EndTime: now,
                MetricDataQueries: [
                  {
                    Id: 'cpu',
                    MetricStat: {
                      Metric: {
                        Namespace: 'AWS/RDS',
                        MetricName: 'CPUUtilization',
                        Dimensions: [
                          { Name: 'DBInstanceIdentifier', Value: db.DBInstanceIdentifier },
                        ],
                      },
                      Period: 14 * 24 * 3600,
                      Stat: 'Average',
                    },
                  },
                  {
                    Id: 'conn',
                    MetricStat: {
                      Metric: {
                        Namespace: 'AWS/RDS',
                        MetricName: 'DatabaseConnections',
                        Dimensions: [
                          { Name: 'DBInstanceIdentifier', Value: db.DBInstanceIdentifier },
                        ],
                      },
                      Period: 14 * 24 * 3600,
                      Stat: 'Average',
                    },
                  },
                ],
              })
            );

            const cpuResult = metricsRes.MetricDataResults?.find((r) => r.Id === 'cpu');
            const connResult = metricsRes.MetricDataResults?.find((r) => r.Id === 'conn');

            const cpuValues = cpuResult?.Values || [];
            const connValues = connResult?.Values || [];

            avgCpu = cpuValues.length > 0
              ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length
              : 0;
            avgConnections = connValues.length > 0
              ? connValues.reduce((a, b) => a + b, 0) / connValues.length
              : 0;
          } catch {
            // If we can't get metrics, leave at 0 (won't trigger recommendations)
          }

          instances.push({
            dbInstanceId: db.DBInstanceIdentifier,
            dbInstanceClass: db.DBInstanceClass || 'unknown',
            engine: db.Engine || 'unknown',
            status: db.DBInstanceStatus || 'unknown',
            allocatedStorage: db.AllocatedStorage || 0,
            averageCpuPercent: Math.round(avgCpu * 100) / 100,
            averageConnections: Math.round(avgConnections * 100) / 100,
            multiAZ: db.MultiAZ || false,
          });
        }

        marker = res.Marker;
      } while (marker);

      return instances;
    },

    async listLambdaFunctions(): Promise<LambdaFunction[]> {
      const lambda = await getLambdaClient();
      const cw = await getCloudWatchClient();
      const functions: LambdaFunction[] = [];
      let marker: string | undefined;

      do {
        const res = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
        for (const fn of res.Functions || []) {
          if (!fn.FunctionName) continue;

          let avgInvocationsPerDay = 0;
          let avgDurationMs = 0;

          try {
            const now = new Date();
            const startTime = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

            const metricsRes = await cw.send(
              new GetMetricDataCommand({
                StartTime: startTime,
                EndTime: now,
                MetricDataQueries: [
                  {
                    Id: 'invocations',
                    MetricStat: {
                      Metric: {
                        Namespace: 'AWS/Lambda',
                        MetricName: 'Invocations',
                        Dimensions: [{ Name: 'FunctionName', Value: fn.FunctionName }],
                      },
                      Period: 86400, // 1 day
                      Stat: 'Sum',
                    },
                  },
                  {
                    Id: 'duration',
                    MetricStat: {
                      Metric: {
                        Namespace: 'AWS/Lambda',
                        MetricName: 'Duration',
                        Dimensions: [{ Name: 'FunctionName', Value: fn.FunctionName }],
                      },
                      Period: 14 * 24 * 3600,
                      Stat: 'Average',
                    },
                  },
                ],
              })
            );

            const invResult = metricsRes.MetricDataResults?.find((r) => r.Id === 'invocations');
            const durResult = metricsRes.MetricDataResults?.find((r) => r.Id === 'duration');

            const invValues = invResult?.Values || [];
            avgInvocationsPerDay = invValues.length > 0
              ? invValues.reduce((a, b) => a + b, 0) / invValues.length
              : 0;

            const durValues = durResult?.Values || [];
            avgDurationMs = durValues.length > 0
              ? durValues.reduce((a, b) => a + b, 0) / durValues.length
              : 0;
          } catch {
            // If metrics unavailable, leave at 0
          }

          functions.push({
            functionName: fn.FunctionName,
            runtime: fn.Runtime || 'unknown',
            memoryMB: fn.MemorySize || 128,
            timeoutSeconds: fn.Timeout || 3,
            codeSize: fn.CodeSize || 0,
            lastModified: fn.LastModified || '',
            avgInvocationsPerDay: Math.round(avgInvocationsPerDay * 100) / 100,
            avgDurationMs: Math.round(avgDurationMs * 100) / 100,
          });
        }
        marker = res.NextMarker;
      } while (marker);

      return functions;
    },

    async listLoadBalancers(): Promise<LoadBalancerInfo[]> {
      const elb = await getELBv2Client();
      const cw = await getCloudWatchClient();
      const loadBalancers: LoadBalancerInfo[] = [];

      let marker: string | undefined;
      do {
        const res = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker }));
        for (const lb of res.LoadBalancers || []) {
          if (!lb.LoadBalancerArn) continue;

          // Count targets across all associated target groups
          let activeTargetCount = 0;
          let totalTargetCount = 0;

          try {
            const tgRes = await elb.send(
              new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn })
            );
            for (const tg of tgRes.TargetGroups || []) {
              if (!tg.TargetGroupArn) continue;
              const healthRes = await elb.send(
                new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn })
              );
              for (const desc of healthRes.TargetHealthDescriptions || []) {
                totalTargetCount++;
                if (desc.TargetHealth?.State === 'healthy') {
                  activeTargetCount++;
                }
              }
            }
          } catch {
            // Skip if permissions issue
          }

          // Get request count from CloudWatch
          let requestCountPerDay = 0;
          try {
            const now = new Date();
            const startTime = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
            const lbArnSuffix = lb.LoadBalancerArn.split(':loadbalancer/')[1] || '';

            const metricName = lb.Type === 'network' ? 'ActiveFlowCount' : 'RequestCount';
            const namespace = 'AWS/ApplicationELB';

            const metricsRes = await cw.send(
              new GetMetricDataCommand({
                StartTime: startTime,
                EndTime: now,
                MetricDataQueries: [
                  {
                    Id: 'requests',
                    MetricStat: {
                      Metric: {
                        Namespace: lb.Type === 'network' ? 'AWS/NetworkELB' : namespace,
                        MetricName: metricName,
                        Dimensions: [{ Name: 'LoadBalancer', Value: lbArnSuffix }],
                      },
                      Period: 86400,
                      Stat: 'Sum',
                    },
                  },
                ],
              })
            );

            const reqResult = metricsRes.MetricDataResults?.find((r) => r.Id === 'requests');
            const reqValues = reqResult?.Values || [];
            requestCountPerDay = reqValues.length > 0
              ? reqValues.reduce((a, b) => a + b, 0) / reqValues.length
              : 0;
          } catch {
            // If metrics unavailable, leave at 0
          }

          loadBalancers.push({
            loadBalancerArn: lb.LoadBalancerArn,
            loadBalancerName: lb.LoadBalancerName || 'unnamed',
            type: lb.Type || 'application',
            state: lb.State?.Code || 'unknown',
            createdAt: lb.CreatedTime || new Date(),
            activeTargetCount,
            totalTargetCount,
            requestCountPerDay: Math.round(requestCountPerDay),
          });
        }
        marker = res.NextMarker;
      } while (marker);

      return loadBalancers;
    },

    async listNatGateways(): Promise<NatGatewayInfo[]> {
      const ec2 = await getEC2Client();
      const cw = await getCloudWatchClient();
      const gateways: NatGatewayInfo[] = [];

      const res = await ec2.send(new DescribeNatGatewaysCommand({}));
      for (const nat of res.NatGateways || []) {
        if (!nat.NatGatewayId || nat.State !== 'available') continue;

        let bytesProcessedPerDay = 0;
        try {
          const now = new Date();
          const startTime = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

          const metricsRes = await cw.send(
            new GetMetricDataCommand({
              StartTime: startTime,
              EndTime: now,
              MetricDataQueries: [
                {
                  Id: 'bytes_out_dst',
                  MetricStat: {
                    Metric: {
                      Namespace: 'AWS/NATGateway',
                      MetricName: 'BytesOutToDestination',
                      Dimensions: [{ Name: 'NatGatewayId', Value: nat.NatGatewayId }],
                    },
                    Period: 86400,
                    Stat: 'Sum',
                  },
                },
                {
                  Id: 'bytes_out_src',
                  MetricStat: {
                    Metric: {
                      Namespace: 'AWS/NATGateway',
                      MetricName: 'BytesOutToSource',
                      Dimensions: [{ Name: 'NatGatewayId', Value: nat.NatGatewayId }],
                    },
                    Period: 86400,
                    Stat: 'Sum',
                  },
                },
              ],
            })
          );

          const dstResult = metricsRes.MetricDataResults?.find((r) => r.Id === 'bytes_out_dst');
          const srcResult = metricsRes.MetricDataResults?.find((r) => r.Id === 'bytes_out_src');

          const dstValues = dstResult?.Values || [];
          const srcValues = srcResult?.Values || [];

          const avgDst = dstValues.length > 0
            ? dstValues.reduce((a, b) => a + b, 0) / dstValues.length
            : 0;
          const avgSrc = srcValues.length > 0
            ? srcValues.reduce((a, b) => a + b, 0) / srcValues.length
            : 0;

          bytesProcessedPerDay = avgDst + avgSrc;
        } catch {
          // If metrics unavailable, leave at 0
        }

        gateways.push({
          natGatewayId: nat.NatGatewayId,
          state: nat.State || 'unknown',
          subnetId: nat.SubnetId || '',
          vpcId: nat.VpcId || '',
          createdAt: nat.CreateTime || new Date(),
          bytesProcessedPerDay: Math.round(bytesProcessedPerDay),
        });
      }

      return gateways;
    },

    async listElasticIPs(): Promise<ElasticIPInfo[]> {
      const ec2 = await getEC2Client();
      const res = await ec2.send(new DescribeAddressesCommand({}));
      const eips: ElasticIPInfo[] = [];

      for (const addr of res.Addresses || []) {
        if (!addr.AllocationId) continue;
        eips.push({
          allocationId: addr.AllocationId,
          publicIp: addr.PublicIp || '',
          associationId: addr.AssociationId || undefined,
          instanceId: addr.InstanceId || undefined,
          domain: addr.Domain || 'vpc',
        });
      }

      return eips;
    },

    async getCostData(): Promise<CostData> {
      const ce = await getCostExplorerClient();
      const now = new Date();
      const formatDate = (d: Date) => d.toISOString().split('T')[0];

      // Query last 6 months to capture full billing history.
      // The AWS console "month-to-date" may include accrued charges
      // from prior months or ongoing reservations.
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);

      const res = await ce.send(
        new GetCostAndUsageCommand({
          TimePeriod: {
            Start: formatDate(sixMonthsAgo),
            End: formatDate(now),
          },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        })
      );

      // Sum all months to get cumulative cost, then compute monthly average
      const byServiceTotal: Record<string, number> = {};
      let grandTotal = 0;
      let monthCount = 0;
      const monthTotals: number[] = [];

      for (const result of res.ResultsByTime || []) {
        let monthTotal = 0;
        for (const group of result.Groups || []) {
          const serviceName = group.Keys?.[0] || 'Other';
          const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
          byServiceTotal[serviceName] = (byServiceTotal[serviceName] || 0) + amount;
          monthTotal += amount;
        }
        monthTotals.push(monthTotal);
        grandTotal += monthTotal;
        monthCount++;
      }

      // Use the most recent complete month if available,
      // otherwise use the average
      const latestMonthCost = monthCount > 1
        ? monthTotals[monthTotals.length - 2] // last complete month
        : grandTotal;

      // For per-service, use totals divided by months for monthly average
      const byServiceMonthly: Record<string, number> = {};
      for (const [service, total] of Object.entries(byServiceTotal)) {
        const monthly = monthCount > 0 ? total / monthCount : total;
        byServiceMonthly[service] = Math.round(monthly * 10000) / 10000;
      }

      // Filter out services with zero cost
      const filtered = Object.fromEntries(
        Object.entries(byServiceMonthly).filter(([, v]) => v > 0)
      );

      return {
        totalMonthly: Math.round(grandTotal * 100) / 100,
        byService: filtered,
        currency: 'USD',
      };
    },
  };
}
