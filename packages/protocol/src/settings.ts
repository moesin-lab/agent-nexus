export type SettingsDurability = 'durable' | 'in-memory' | 'derived';

export interface PlatformSettingsSnapshotInput {
  userId: string;
  channelId: string;
  threadParentChannelId?: string;
}

export interface SettingsSnapshotItem {
  key: string;
  label: string;
  owner: 'platform' | 'daemon' | 'agent';
  value: string;
  source: string;
  durability: SettingsDurability;
  canChange: boolean;
}

export interface PlatformSettingsSnapshot {
  items: SettingsSnapshotItem[];
}

export interface PlatformSettingsActionInput
  extends PlatformSettingsSnapshotInput {
  action: string;
  value?: string;
}

export interface PlatformSettingsActionResult {
  status: 'handled' | 'rejected' | 'unsupported';
  message: string;
}
