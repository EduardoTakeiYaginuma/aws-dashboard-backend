/**
 * Resource Sync Service
 *
 * Collects ALL AWS resources from a workspace and upserts them into the Resource table.
 * Covers: EC2, EBS, S3, RDS, Lambda, ALB/NLB, CloudFront, VPC, Subnets,
 * Security Groups, NAT Gateways, Internet Gateways, Elastic IPs, Auto Scaling Groups,
 * Elastic Beanstalk, DynamoDB, SNS, SQS, Route 53, IAM Roles/Users, CloudFormation Stacks.
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeNatGatewaysCommand,
  DescribeInternetGatewaysCommand,
  DescribeAddressesCommand,
} from '@aws-sdk/client-ec2';
import {
  LambdaClient,
  ListFunctionsCommand,
  type FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  CloudFrontClient,
  ListDistributionsCommand,
} from '@aws-sdk/client-cloudfront';
import {
  IAMClient,
  ListRolesCommand,
  ListUsersCommand,
  ListPoliciesCommand,
} from '@aws-sdk/client-iam';
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { SNSClient, ListTopicsCommand } from '@aws-sdk/client-sns';
import { SQSClient, ListQueuesCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Route53Client, ListHostedZonesCommand } from '@aws-sdk/client-route-53';
import {
  ElasticBeanstalkClient,
  DescribeEnvironmentsCommand,
  DescribeApplicationsCommand,
} from '@aws-sdk/client-elastic-beanstalk';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  CloudFormationClient,
  ListStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  RDSClient,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
} from '@aws-sdk/client-s3';
import type { Credentials } from '@aws-sdk/types';
import prisma from '../db';

const DEFAULT_REGION = process.env.AWS_REGION || 'us-east-1';

interface ResourceRecord {
  resourceId: string;
  arn?: string;
  service: string;
  type?: string;
  name?: string;
  tags?: Record<string, string>;
  state?: string;
  estimatedMonthlyCost?: number;
  metadata?: Record<string, unknown>;
}

async function assumeRole(roleArn: string): Promise<Credentials> {
  const sts = new STSClient({ region: DEFAULT_REGION });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'resource-sync',
      DurationSeconds: 3600,
    })
  );
  if (!result.Credentials) throw new Error('AssumeRole did not return credentials');
  return {
    accessKeyId: result.Credentials.AccessKeyId!,
    secretAccessKey: result.Credentials.SecretAccessKey!,
    sessionToken: result.Credentials.SessionToken!,
    expiration: result.Credentials.Expiration,
  };
}

// ─── Collector functions ───────────────────────────────────────────────

async function collectEC2(creds: Credentials, accountId: string): Promise<ResourceRecord[]> {
  const ec2 = new EC2Client({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];
  let nextToken: string | undefined;

  do {
    const res = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const reservation of res.Reservations || []) {
      for (const inst of reservation.Instances || []) {
        if (!inst.InstanceId) continue;
        const tags: Record<string, string> = {};
        for (const t of inst.Tags || []) {
          if (t.Key && t.Value) tags[t.Key] = t.Value;
        }
        resources.push({
          resourceId: inst.InstanceId,
          arn: `arn:aws:ec2:${DEFAULT_REGION}:${accountId}:instance/${inst.InstanceId}`,
          service: 'EC2',
          type: inst.InstanceType || 'unknown',
          name: tags['Name'] || inst.InstanceId,
          tags,
          state: inst.State?.Name || 'unknown',
          metadata: {
            platform: inst.Platform || 'linux',
            architecture: inst.Architecture,
            launchTime: inst.LaunchTime?.toISOString(),
            privateIp: inst.PrivateIpAddress,
            publicIp: inst.PublicIpAddress,
            vpcId: inst.VpcId,
            subnetId: inst.SubnetId,
            amiId: inst.ImageId,
            keyName: inst.KeyName,
            iamProfile: inst.IamInstanceProfile?.Arn,
            monitoring: inst.Monitoring?.State,
            securityGroups: (inst.SecurityGroups || []).map(sg => ({
              id: sg.GroupId,
              name: sg.GroupName,
            })),
          },
        });
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return resources;
}

async function collectEBS(creds: Credentials, accountId: string): Promise<ResourceRecord[]> {
  const ec2 = new EC2Client({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];
  let nextToken: string | undefined;

  do {
    const res = await ec2.send(new DescribeVolumesCommand({ NextToken: nextToken }));
    for (const vol of res.Volumes || []) {
      if (!vol.VolumeId) continue;
      const tags: Record<string, string> = {};
      for (const t of vol.Tags || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      const attachedTo = (vol.Attachments || []).map(a => a.InstanceId).filter(Boolean).join(', ');
      resources.push({
        resourceId: vol.VolumeId,
        arn: `arn:aws:ec2:${DEFAULT_REGION}:${accountId}:volume/${vol.VolumeId}`,
        service: 'EBS',
        type: vol.VolumeType || 'gp2',
        name: tags['Name'] || vol.VolumeId,
        tags,
        state: vol.Attachments?.length ? 'in-use' : 'available',
        metadata: {
          sizeGiB: vol.Size,
          iops: vol.Iops,
          throughput: vol.Throughput,
          encrypted: vol.Encrypted,
          snapshotId: vol.SnapshotId,
          availabilityZone: vol.AvailabilityZone,
          createTime: vol.CreateTime?.toISOString(),
          attachedTo,
        },
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return resources;
}

async function collectS3(creds: Credentials): Promise<ResourceRecord[]> {
  const s3 = new S3Client({ region: DEFAULT_REGION, credentials: creds });
  const res = await s3.send(new ListBucketsCommand({}));
  const resources: ResourceRecord[] = [];

  for (const bucket of res.Buckets || []) {
    if (!bucket.Name) continue;

    let region = DEFAULT_REGION;
    try {
      const locRes = await s3.send(new GetBucketLocationCommand({ Bucket: bucket.Name }));
      region = locRes.LocationConstraint || 'us-east-1';
    } catch { /* use default */ }

    let tags: Record<string, string> = {};
    try {
      const tagRes = await s3.send(new GetBucketTaggingCommand({ Bucket: bucket.Name }));
      for (const t of tagRes.TagSet || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
    } catch { /* no tags */ }

    let objectCount = 0;
    let sizeBytes = 0;
    try {
      const regionS3 = new S3Client({ region, credentials: creds });
      const objRes = await regionS3.send(
        new ListObjectsV2Command({ Bucket: bucket.Name, MaxKeys: 100 })
      );
      objectCount = objRes.KeyCount || 0;
      for (const obj of objRes.Contents || []) {
        sizeBytes += obj.Size || 0;
      }
    } catch { /* skip */ }

    resources.push({
      resourceId: bucket.Name,
      arn: `arn:aws:s3:::${bucket.Name}`,
      service: 'S3',
      type: 'Bucket',
      name: bucket.Name,
      tags,
      state: 'active',
      metadata: {
        region,
        creationDate: bucket.CreationDate?.toISOString(),
        objectCount,
        sizeBytes,
        sizeMB: Math.round(sizeBytes / 1024 / 1024 * 100) / 100,
      },
    });
  }

  return resources;
}

async function collectRDS(creds: Credentials, accountId: string): Promise<ResourceRecord[]> {
  const rds = new RDSClient({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];
  let marker: string | undefined;

  do {
    const res = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }));
    for (const db of res.DBInstances || []) {
      if (!db.DBInstanceIdentifier) continue;
      const tags: Record<string, string> = {};
      for (const t of db.TagList || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      resources.push({
        resourceId: db.DBInstanceIdentifier,
        arn: db.DBInstanceArn || `arn:aws:rds:${DEFAULT_REGION}:${accountId}:db:${db.DBInstanceIdentifier}`,
        service: 'RDS',
        type: db.DBInstanceClass || 'unknown',
        name: tags['Name'] || db.DBInstanceIdentifier,
        tags,
        state: db.DBInstanceStatus || 'unknown',
        metadata: {
          engine: db.Engine,
          engineVersion: db.EngineVersion,
          allocatedStorageGiB: db.AllocatedStorage,
          multiAZ: db.MultiAZ,
          storageType: db.StorageType,
          endpoint: db.Endpoint ? `${db.Endpoint.Address}:${db.Endpoint.Port}` : null,
          vpcId: db.DBSubnetGroup?.VpcId,
          publiclyAccessible: db.PubliclyAccessible,
          encrypted: db.StorageEncrypted,
          autoMinorVersionUpgrade: db.AutoMinorVersionUpgrade,
          backupRetentionDays: db.BackupRetentionPeriod,
          createdAt: db.InstanceCreateTime?.toISOString(),
        },
      });
    }
    marker = res.Marker;
  } while (marker);

  return resources;
}

async function collectLambda(creds: Credentials): Promise<ResourceRecord[]> {
  const lambda = new LambdaClient({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];
  let marker: string | undefined;

  do {
    const res = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
    for (const fn of res.Functions || []) {
      if (!fn.FunctionName) continue;
      const tags: Record<string, string> = {};
      // Lambda tags come from GetFunction, but ListFunctions doesn't include them
      // We'll skip per-function GetFunction calls for performance
      resources.push({
        resourceId: fn.FunctionName,
        arn: fn.FunctionArn,
        service: 'Lambda',
        type: `${fn.Runtime || 'unknown'} / ${fn.MemorySize || 128}MB`,
        name: fn.FunctionName,
        tags,
        state: fn.State || 'Active',
        metadata: {
          runtime: fn.Runtime,
          handler: fn.Handler,
          memoryMB: fn.MemorySize,
          timeoutSeconds: fn.Timeout,
          codeSize: fn.CodeSize,
          codeSizeMB: Math.round((fn.CodeSize || 0) / 1024 / 1024 * 100) / 100,
          lastModified: fn.LastModified,
          description: fn.Description,
          role: fn.Role,
          layers: (fn.Layers || []).map(l => l.Arn),
          architectures: fn.Architectures,
          ephemeralStorageMB: fn.EphemeralStorage?.Size,
          packageType: fn.PackageType,
        },
      });
    }
    marker = res.NextMarker;
  } while (marker);

  return resources;
}

async function collectLoadBalancers(creds: Credentials): Promise<ResourceRecord[]> {
  const elb = new ElasticLoadBalancingV2Client({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];
  let marker: string | undefined;

  do {
    const res = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker }));
    for (const lb of res.LoadBalancers || []) {
      if (!lb.LoadBalancerArn) continue;
      resources.push({
        resourceId: lb.LoadBalancerName || lb.LoadBalancerArn,
        arn: lb.LoadBalancerArn,
        service: 'ELB',
        type: lb.Type || 'application',
        name: lb.LoadBalancerName || 'unnamed',
        state: lb.State?.Code || 'unknown',
        metadata: {
          scheme: lb.Scheme,
          dnsName: lb.DNSName,
          vpcId: lb.VpcId,
          type: lb.Type,
          ipAddressType: lb.IpAddressType,
          createdAt: lb.CreatedTime?.toISOString(),
          availabilityZones: (lb.AvailabilityZones || []).map(az => ({
            zone: az.ZoneName,
            subnetId: az.SubnetId,
          })),
          securityGroups: lb.SecurityGroups,
        },
      });
    }
    marker = res.NextMarker;
  } while (marker);

  // Also collect Target Groups
  try {
    let tgMarker: string | undefined;
    do {
      const tgRes = await elb.send(new DescribeTargetGroupsCommand({ Marker: tgMarker }));
      for (const tg of tgRes.TargetGroups || []) {
        if (!tg.TargetGroupArn) continue;
        resources.push({
          resourceId: tg.TargetGroupName || tg.TargetGroupArn,
          arn: tg.TargetGroupArn,
          service: 'ELB',
          type: 'TargetGroup',
          name: tg.TargetGroupName || 'unnamed',
          state: 'active',
          metadata: {
            protocol: tg.Protocol,
            port: tg.Port,
            targetType: tg.TargetType,
            vpcId: tg.VpcId,
            healthCheck: {
              protocol: tg.HealthCheckProtocol,
              port: tg.HealthCheckPort,
              path: tg.HealthCheckPath,
              intervalSeconds: tg.HealthCheckIntervalSeconds,
            },
            loadBalancerArns: tg.LoadBalancerArns,
          },
        });
      }
      tgMarker = tgRes.NextMarker;
    } while (tgMarker);
  } catch { /* skip if no permissions */ }

  return resources;
}

async function collectCloudFront(creds: Credentials): Promise<ResourceRecord[]> {
  const cf = new CloudFrontClient({ region: 'us-east-1', credentials: creds });
  const resources: ResourceRecord[] = [];

  try {
    let marker: string | undefined;
    do {
      const res = await cf.send(new ListDistributionsCommand({ Marker: marker }));
      const list = res.DistributionList;
      for (const dist of list?.Items || []) {
        if (!dist.Id) continue;
        resources.push({
          resourceId: dist.Id,
          arn: dist.ARN,
          service: 'CloudFront',
          type: 'Distribution',
          name: dist.Comment || dist.DomainName || dist.Id,
          state: dist.Enabled ? 'enabled' : 'disabled',
          metadata: {
            domainName: dist.DomainName,
            aliases: dist.Aliases?.Items || [],
            status: dist.Status,
            priceClass: dist.PriceClass,
            httpVersion: dist.HttpVersion,
            isIPV6Enabled: dist.IsIPV6Enabled,
            origins: (dist.Origins?.Items || []).map(o => ({
              id: o.Id,
              domainName: o.DomainName,
            })),
            lastModified: dist.LastModifiedTime?.toISOString(),
          },
        });
      }
      marker = list?.NextMarker;
      if (!list?.IsTruncated) break;
    } while (marker);
  } catch { /* skip if no permissions */ }

  return resources;
}

async function collectVPCResources(creds: Credentials, accountId: string): Promise<ResourceRecord[]> {
  const ec2 = new EC2Client({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];

  // VPCs
  try {
    const res = await ec2.send(new DescribeVpcsCommand({}));
    for (const vpc of res.Vpcs || []) {
      if (!vpc.VpcId) continue;
      const tags: Record<string, string> = {};
      for (const t of vpc.Tags || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      resources.push({
        resourceId: vpc.VpcId,
        arn: `arn:aws:ec2:${DEFAULT_REGION}:${accountId}:vpc/${vpc.VpcId}`,
        service: 'VPC',
        type: 'VPC',
        name: tags['Name'] || vpc.VpcId,
        tags,
        state: vpc.State || 'available',
        metadata: {
          cidrBlock: vpc.CidrBlock,
          isDefault: vpc.IsDefault,
          dhcpOptionsId: vpc.DhcpOptionsId,
          instanceTenancy: vpc.InstanceTenancy,
          cidrBlockAssociations: (vpc.CidrBlockAssociationSet || []).map(c => c.CidrBlock),
        },
      });
    }
  } catch { /* skip */ }

  // Subnets
  try {
    const res = await ec2.send(new DescribeSubnetsCommand({}));
    for (const subnet of res.Subnets || []) {
      if (!subnet.SubnetId) continue;
      const tags: Record<string, string> = {};
      for (const t of subnet.Tags || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      resources.push({
        resourceId: subnet.SubnetId,
        arn: subnet.SubnetArn || `arn:aws:ec2:${DEFAULT_REGION}:${accountId}:subnet/${subnet.SubnetId}`,
        service: 'VPC',
        type: 'Subnet',
        name: tags['Name'] || subnet.SubnetId,
        tags,
        state: subnet.State || 'available',
        metadata: {
          vpcId: subnet.VpcId,
          cidrBlock: subnet.CidrBlock,
          availabilityZone: subnet.AvailabilityZone,
          availableIps: subnet.AvailableIpAddressCount,
          mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch,
          defaultForAz: subnet.DefaultForAz,
        },
      });
    }
  } catch { /* skip */ }

  // Security Groups
  try {
    const res = await ec2.send(new DescribeSecurityGroupsCommand({}));
    for (const sg of res.SecurityGroups || []) {
      if (!sg.GroupId) continue;
      const tags: Record<string, string> = {};
      for (const t of sg.Tags || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      resources.push({
        resourceId: sg.GroupId,
        arn: `arn:aws:ec2:${DEFAULT_REGION}:${accountId}:security-group/${sg.GroupId}`,
        service: 'VPC',
        type: 'SecurityGroup',
        name: tags['Name'] || sg.GroupName || sg.GroupId,
        tags,
        state: 'active',
        metadata: {
          groupName: sg.GroupName,
          description: sg.Description,
          vpcId: sg.VpcId,
          inboundRules: (sg.IpPermissions || []).map(rule => ({
            protocol: rule.IpProtocol,
            fromPort: rule.FromPort,
            toPort: rule.ToPort,
            sources: [
              ...(rule.IpRanges || []).map(r => r.CidrIp),
              ...(rule.UserIdGroupPairs || []).map(g => g.GroupId),
            ],
          })),
          outboundRules: (sg.IpPermissionsEgress || []).map(rule => ({
            protocol: rule.IpProtocol,
            fromPort: rule.FromPort,
            toPort: rule.ToPort,
            destinations: [
              ...(rule.IpRanges || []).map(r => r.CidrIp),
              ...(rule.UserIdGroupPairs || []).map(g => g.GroupId),
            ],
          })),
        },
      });
    }
  } catch { /* skip */ }

  // NAT Gateways
  try {
    const res = await ec2.send(new DescribeNatGatewaysCommand({}));
    for (const nat of res.NatGateways || []) {
      if (!nat.NatGatewayId) continue;
      const tags: Record<string, string> = {};
      for (const t of nat.Tags || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      resources.push({
        resourceId: nat.NatGatewayId,
        service: 'VPC',
        type: 'NATGateway',
        name: tags['Name'] || nat.NatGatewayId,
        tags,
        state: nat.State || 'unknown',
        metadata: {
          subnetId: nat.SubnetId,
          vpcId: nat.VpcId,
          connectivityType: nat.ConnectivityType,
          addresses: (nat.NatGatewayAddresses || []).map(a => ({
            publicIp: a.PublicIp,
            privateIp: a.PrivateIp,
            allocationId: a.AllocationId,
          })),
          createdAt: nat.CreateTime?.toISOString(),
        },
      });
    }
  } catch { /* skip */ }

  // Internet Gateways
  try {
    const res = await ec2.send(new DescribeInternetGatewaysCommand({}));
    for (const igw of res.InternetGateways || []) {
      if (!igw.InternetGatewayId) continue;
      const tags: Record<string, string> = {};
      for (const t of igw.Tags || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      resources.push({
        resourceId: igw.InternetGatewayId,
        service: 'VPC',
        type: 'InternetGateway',
        name: tags['Name'] || igw.InternetGatewayId,
        tags,
        state: 'active',
        metadata: {
          attachments: (igw.Attachments || []).map(a => ({
            vpcId: a.VpcId,
            state: a.State,
          })),
        },
      });
    }
  } catch { /* skip */ }

  // Elastic IPs
  try {
    const res = await ec2.send(new DescribeAddressesCommand({}));
    for (const eip of res.Addresses || []) {
      if (!eip.AllocationId) continue;
      const tags: Record<string, string> = {};
      for (const t of eip.Tags || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      resources.push({
        resourceId: eip.AllocationId,
        service: 'VPC',
        type: 'ElasticIP',
        name: tags['Name'] || eip.PublicIp || eip.AllocationId,
        tags,
        state: eip.AssociationId ? 'associated' : 'unassociated',
        metadata: {
          publicIp: eip.PublicIp,
          privateIp: eip.PrivateIpAddress,
          instanceId: eip.InstanceId,
          networkInterfaceId: eip.NetworkInterfaceId,
          domain: eip.Domain,
        },
      });
    }
  } catch { /* skip */ }

  return resources;
}

async function collectAutoScaling(creds: Credentials): Promise<ResourceRecord[]> {
  const asg = new AutoScalingClient({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];

  try {
    let nextToken: string | undefined;
    do {
      const res = await asg.send(new DescribeAutoScalingGroupsCommand({ NextToken: nextToken }));
      for (const group of res.AutoScalingGroups || []) {
        if (!group.AutoScalingGroupName) continue;
        const tags: Record<string, string> = {};
        for (const t of group.Tags || []) {
          if (t.Key && t.Value) tags[t.Key] = t.Value;
        }
        resources.push({
          resourceId: group.AutoScalingGroupName,
          arn: group.AutoScalingGroupARN,
          service: 'AutoScaling',
          type: 'AutoScalingGroup',
          name: tags['Name'] || group.AutoScalingGroupName,
          tags,
          state: group.Status || 'active',
          metadata: {
            minSize: group.MinSize,
            maxSize: group.MaxSize,
            desiredCapacity: group.DesiredCapacity,
            currentInstances: group.Instances?.length || 0,
            instanceIds: (group.Instances || []).map(i => i.InstanceId),
            launchTemplate: group.LaunchTemplate ? {
              id: group.LaunchTemplate.LaunchTemplateId,
              name: group.LaunchTemplate.LaunchTemplateName,
              version: group.LaunchTemplate.Version,
            } : null,
            availabilityZones: group.AvailabilityZones,
            healthCheckType: group.HealthCheckType,
            targetGroupARNs: group.TargetGroupARNs,
            loadBalancerNames: group.LoadBalancerNames,
            createdAt: group.CreatedTime?.toISOString(),
          },
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch { /* skip */ }

  return resources;
}

async function collectElasticBeanstalk(creds: Credentials): Promise<ResourceRecord[]> {
  const eb = new ElasticBeanstalkClient({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];

  try {
    // Applications
    const appsRes = await eb.send(new DescribeApplicationsCommand({}));
    for (const app of appsRes.Applications || []) {
      if (!app.ApplicationName) continue;
      resources.push({
        resourceId: `eb-app-${app.ApplicationName}`,
        arn: app.ApplicationArn,
        service: 'ElasticBeanstalk',
        type: 'Application',
        name: app.ApplicationName,
        state: 'active',
        metadata: {
          description: app.Description,
          dateCreated: app.DateCreated?.toISOString(),
          dateUpdated: app.DateUpdated?.toISOString(),
          versions: app.Versions,
          configurationTemplates: app.ConfigurationTemplates,
        },
      });
    }

    // Environments
    const envsRes = await eb.send(new DescribeEnvironmentsCommand({}));
    for (const env of envsRes.Environments || []) {
      if (!env.EnvironmentId) continue;
      resources.push({
        resourceId: env.EnvironmentId,
        arn: env.EnvironmentArn,
        service: 'ElasticBeanstalk',
        type: 'Environment',
        name: env.EnvironmentName || env.EnvironmentId,
        state: env.Status || 'unknown',
        metadata: {
          applicationName: env.ApplicationName,
          solutionStack: env.SolutionStackName,
          platformArn: env.PlatformArn,
          health: env.Health,
          healthStatus: env.HealthStatus,
          tier: env.Tier ? { name: env.Tier.Name, type: env.Tier.Type } : null,
          cname: env.CNAME,
          endpointUrl: env.EndpointURL,
          dateCreated: env.DateCreated?.toISOString(),
          dateUpdated: env.DateUpdated?.toISOString(),
          versionLabel: env.VersionLabel,
        },
      });
    }
  } catch { /* skip */ }

  return resources;
}

async function collectDynamoDB(creds: Credentials, accountId: string): Promise<ResourceRecord[]> {
  const ddb = new DynamoDBClient({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];

  try {
    let lastEvaluatedTableName: string | undefined;
    do {
      const res = await ddb.send(
        new ListTablesCommand({ ExclusiveStartTableName: lastEvaluatedTableName })
      );
      for (const tableName of res.TableNames || []) {
        try {
          const desc = await ddb.send(new DescribeTableCommand({ TableName: tableName }));
          const table = desc.Table;
          if (!table) continue;
          resources.push({
            resourceId: tableName,
            arn: table.TableArn || `arn:aws:dynamodb:${DEFAULT_REGION}:${accountId}:table/${tableName}`,
            service: 'DynamoDB',
            type: table.BillingModeSummary?.BillingMode || 'PROVISIONED',
            name: tableName,
            state: table.TableStatus || 'unknown',
            metadata: {
              itemCount: table.ItemCount,
              sizeBytes: table.TableSizeBytes,
              sizeMB: Math.round((table.TableSizeBytes || 0) / 1024 / 1024 * 100) / 100,
              readCapacity: table.ProvisionedThroughput?.ReadCapacityUnits,
              writeCapacity: table.ProvisionedThroughput?.WriteCapacityUnits,
              gsi: (table.GlobalSecondaryIndexes || []).map(i => ({
                name: i.IndexName,
                status: i.IndexStatus,
                keys: (i.KeySchema || []).map(k => `${k.AttributeName} (${k.KeyType})`),
              })),
              lsi: (table.LocalSecondaryIndexes || []).map(i => ({
                name: i.IndexName,
                keys: (i.KeySchema || []).map(k => `${k.AttributeName} (${k.KeyType})`),
              })),
              keys: (table.KeySchema || []).map(k => `${k.AttributeName} (${k.KeyType})`),
              streamSpec: table.StreamSpecification ? {
                enabled: table.StreamSpecification.StreamEnabled,
                viewType: table.StreamSpecification.StreamViewType,
              } : null,
              createdAt: table.CreationDateTime?.toISOString(),
            },
          });
        } catch { /* skip individual table */ }
      }
      lastEvaluatedTableName = res.LastEvaluatedTableName;
    } while (lastEvaluatedTableName);
  } catch { /* skip */ }

  return resources;
}

async function collectSNS(creds: Credentials): Promise<ResourceRecord[]> {
  const sns = new SNSClient({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];

  try {
    let nextToken: string | undefined;
    do {
      const res = await sns.send(new ListTopicsCommand({ NextToken: nextToken }));
      for (const topic of res.Topics || []) {
        if (!topic.TopicArn) continue;
        const name = topic.TopicArn.split(':').pop() || topic.TopicArn;
        resources.push({
          resourceId: name,
          arn: topic.TopicArn,
          service: 'SNS',
          type: 'Topic',
          name,
          state: 'active',
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch { /* skip */ }

  return resources;
}

async function collectSQS(creds: Credentials, accountId: string): Promise<ResourceRecord[]> {
  const sqs = new SQSClient({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];

  try {
    let nextToken: string | undefined;
    do {
      const res = await sqs.send(new ListQueuesCommand({ NextToken: nextToken }));
      for (const queueUrl of res.QueueUrls || []) {
        const name = queueUrl.split('/').pop() || queueUrl;
        let metadata: Record<string, unknown> = { queueUrl };

        try {
          const attrs = await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: ['All'],
            })
          );
          const a = attrs.Attributes || {};
          metadata = {
            queueUrl,
            approximateMessages: parseInt(a.ApproximateNumberOfMessages || '0'),
            approximateMessagesNotVisible: parseInt(a.ApproximateNumberOfMessagesNotVisible || '0'),
            approximateMessagesDelayed: parseInt(a.ApproximateNumberOfMessagesDelayed || '0'),
            visibilityTimeout: a.VisibilityTimeout,
            maxMessageSize: a.MaximumMessageSize,
            messageRetentionPeriod: a.MessageRetentionPeriod,
            delaySeconds: a.DelaySeconds,
            fifoQueue: a.FifoQueue === 'true',
            createdTimestamp: a.CreatedTimestamp,
          };
        } catch { /* skip attributes */ }

        resources.push({
          resourceId: name,
          arn: `arn:aws:sqs:${DEFAULT_REGION}:${accountId}:${name}`,
          service: 'SQS',
          type: name.endsWith('.fifo') ? 'FIFO Queue' : 'Standard Queue',
          name,
          state: 'active',
          metadata,
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch { /* skip */ }

  return resources;
}

async function collectRoute53(creds: Credentials): Promise<ResourceRecord[]> {
  const r53 = new Route53Client({ region: 'us-east-1', credentials: creds });
  const resources: ResourceRecord[] = [];

  try {
    let marker: string | undefined;
    do {
      const res = await r53.send(new ListHostedZonesCommand({ Marker: marker }));
      for (const zone of res.HostedZones || []) {
        if (!zone.Id) continue;
        const zoneId = zone.Id.replace('/hostedzone/', '');
        resources.push({
          resourceId: zoneId,
          service: 'Route53',
          type: zone.Config?.PrivateZone ? 'Private Hosted Zone' : 'Public Hosted Zone',
          name: zone.Name || zoneId,
          state: 'active',
          metadata: {
            recordCount: zone.ResourceRecordSetCount,
            comment: zone.Config?.Comment,
            privateZone: zone.Config?.PrivateZone,
          },
        });
      }
      marker = res.NextMarker;
      if (!res.IsTruncated) break;
    } while (marker);
  } catch { /* skip */ }

  return resources;
}

async function collectIAM(creds: Credentials): Promise<ResourceRecord[]> {
  const iam = new IAMClient({ region: 'us-east-1', credentials: creds });
  const resources: ResourceRecord[] = [];

  // IAM Roles (max 100 for performance)
  try {
    let marker: string | undefined;
    let count = 0;
    do {
      const res = await iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 100 }));
      for (const role of res.Roles || []) {
        if (!role.RoleName) continue;
        resources.push({
          resourceId: role.RoleName,
          arn: role.Arn,
          service: 'IAM',
          type: 'Role',
          name: role.RoleName,
          state: 'active',
          metadata: {
            path: role.Path,
            description: role.Description,
            maxSessionDuration: role.MaxSessionDuration,
            createdAt: role.CreateDate?.toISOString(),
          },
        });
        count++;
      }
      marker = res.Marker;
      if (count >= 200) break; // limit for performance
    } while (marker);
  } catch { /* skip */ }

  // IAM Users
  try {
    let marker: string | undefined;
    do {
      const res = await iam.send(new ListUsersCommand({ Marker: marker }));
      for (const user of res.Users || []) {
        if (!user.UserName) continue;
        resources.push({
          resourceId: user.UserName,
          arn: user.Arn,
          service: 'IAM',
          type: 'User',
          name: user.UserName,
          state: 'active',
          metadata: {
            path: user.Path,
            createdAt: user.CreateDate?.toISOString(),
            passwordLastUsed: user.PasswordLastUsed?.toISOString(),
          },
        });
      }
      marker = res.Marker;
    } while (marker);
  } catch { /* skip */ }

  // IAM Policies (only customer-managed)
  try {
    let marker: string | undefined;
    do {
      const res = await iam.send(new ListPoliciesCommand({ Marker: marker, Scope: 'Local' }));
      for (const policy of res.Policies || []) {
        if (!policy.PolicyName) continue;
        resources.push({
          resourceId: policy.PolicyName,
          arn: policy.Arn,
          service: 'IAM',
          type: 'Policy',
          name: policy.PolicyName,
          state: policy.IsAttachable ? 'active' : 'inactive',
          metadata: {
            path: policy.Path,
            description: policy.Description,
            attachmentCount: policy.AttachmentCount,
            createdAt: policy.CreateDate?.toISOString(),
            updatedAt: policy.UpdateDate?.toISOString(),
          },
        });
      }
      marker = res.Marker;
    } while (marker);
  } catch { /* skip */ }

  return resources;
}

async function collectCloudFormation(creds: Credentials): Promise<ResourceRecord[]> {
  const cfn = new CloudFormationClient({ region: DEFAULT_REGION, credentials: creds });
  const resources: ResourceRecord[] = [];

  try {
    let nextToken: string | undefined;
    do {
      const res = await cfn.send(new ListStacksCommand({ NextToken: nextToken }));
      for (const stack of res.StackSummaries || []) {
        if (!stack.StackName) continue;
        if (stack.StackStatus === 'DELETE_COMPLETE') continue;
        resources.push({
          resourceId: stack.StackId || stack.StackName,
          service: 'CloudFormation',
          type: 'Stack',
          name: stack.StackName,
          state: stack.StackStatus || 'unknown',
          metadata: {
            templateDescription: stack.TemplateDescription,
            createdAt: stack.CreationTime?.toISOString(),
            updatedAt: stack.LastUpdatedTime?.toISOString(),
            deletedAt: stack.DeletionTime?.toISOString(),
            driftStatus: stack.DriftInformation?.StackDriftStatus,
          },
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch { /* skip */ }

  return resources;
}

// ─── Main sync function ─────────────────────────────────────────────────

export async function syncWorkspaceResources(workspaceId: string): Promise<{
  total: number;
  byService: Record<string, number>;
  errors: string[];
}> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

  console.log(`[resource-sync] Starting sync for workspace "${workspace.name}" (${workspaceId})`);

  const creds = await assumeRole(workspace.roleArn);
  const accountId = workspace.awsAccountId;
  const errors: string[] = [];

  // Collect from all services in parallel where safe
  const collectors: { name: string; fn: () => Promise<ResourceRecord[]> }[] = [
    { name: 'EC2', fn: () => collectEC2(creds, accountId) },
    { name: 'EBS', fn: () => collectEBS(creds, accountId) },
    { name: 'S3', fn: () => collectS3(creds) },
    { name: 'RDS', fn: () => collectRDS(creds, accountId) },
    { name: 'Lambda', fn: () => collectLambda(creds) },
    { name: 'ELB', fn: () => collectLoadBalancers(creds) },
    { name: 'CloudFront', fn: () => collectCloudFront(creds) },
    { name: 'VPC', fn: () => collectVPCResources(creds, accountId) },
    { name: 'AutoScaling', fn: () => collectAutoScaling(creds) },
    { name: 'ElasticBeanstalk', fn: () => collectElasticBeanstalk(creds) },
    { name: 'DynamoDB', fn: () => collectDynamoDB(creds, accountId) },
    { name: 'SNS', fn: () => collectSNS(creds) },
    { name: 'SQS', fn: () => collectSQS(creds, accountId) },
    { name: 'Route53', fn: () => collectRoute53(creds) },
    { name: 'IAM', fn: () => collectIAM(creds) },
    { name: 'CloudFormation', fn: () => collectCloudFormation(creds) },
  ];

  const allResources: ResourceRecord[] = [];
  const byService: Record<string, number> = {};

  // Run collectors in parallel batches of 4 to avoid rate limiting
  const batchSize = 4;
  for (let i = 0; i < collectors.length; i += batchSize) {
    const batch = collectors.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(c => c.fn()));

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const collectorName = batch[j].name;

      if (result.status === 'fulfilled') {
        const resources = result.value;
        allResources.push(...resources);
        byService[collectorName] = resources.length;
        console.log(`[resource-sync] ${collectorName}: found ${resources.length} resources`);
      } else {
        const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`${collectorName}: ${errMsg}`);
        byService[collectorName] = 0;
        console.warn(`[resource-sync] ${collectorName}: error - ${errMsg}`);
      }
    }
  }

  // Upsert all resources into the database
  console.log(`[resource-sync] Upserting ${allResources.length} resources into database...`);

  for (const resource of allResources) {
    try {
      await prisma.resource.upsert({
        where: {
          workspaceId_resourceId: {
            workspaceId,
            resourceId: resource.resourceId,
          },
        },
        create: {
          workspaceId,
          resourceId: resource.resourceId,
          arn: resource.arn,
          service: resource.service,
          type: resource.type,
          name: resource.name,
          tags: resource.tags as Record<string, string> || undefined,
          metadata: resource.metadata as Record<string, string> || undefined,
          state: resource.state,
          estimatedMonthlyCost: resource.estimatedMonthlyCost ?? 0,
          lastSeenAt: new Date(),
        },
        update: {
          arn: resource.arn,
          service: resource.service,
          type: resource.type,
          name: resource.name,
          tags: resource.tags as Record<string, string> || undefined,
          metadata: resource.metadata as Record<string, string> || undefined,
          state: resource.state,
          estimatedMonthlyCost: resource.estimatedMonthlyCost ?? undefined,
          lastSeenAt: new Date(),
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[resource-sync] Failed to upsert ${resource.service}/${resource.resourceId}: ${errMsg}`);
    }
  }

  // Mark resources not seen in this sync as potentially deleted
  // (resources whose lastSeenAt is older than 1 hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.resource.updateMany({
    where: {
      workspaceId,
      lastSeenAt: { lt: oneHourAgo },
    },
    data: {
      state: 'not-found',
    },
  });

  console.log(`[resource-sync] Sync completed: ${allResources.length} resources across ${Object.keys(byService).length} services`);

  return {
    total: allResources.length,
    byService,
    errors,
  };
}
