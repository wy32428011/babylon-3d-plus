import { createId } from '../../shared/ids';
import type { Entity } from './Entity';
import type { SceneDocument } from './SceneDocument';
import { createDefaultTelemetryBinding, type ModelSubDeviceConfig } from './telemetryBinding';

export type DevicePartBindingComponent = {
  hostEntityId: string;
  role: string;
};

export type CompositeDeviceFolderComponent = {
  hostEntityId: string;
};

function normalizeIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeDevicePartBinding(value: unknown): DevicePartBindingComponent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hostEntityId = normalizeIdentifier(record.hostEntityId);
  const role = normalizeIdentifier(record.role);
  return hostEntityId && role ? { hostEntityId, role } : null;
}

export function normalizeCompositeDeviceFolder(
  value: unknown,
): CompositeDeviceFolderComponent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hostEntityId = normalizeIdentifier(record.hostEntityId);
  return hostEntityId ? { hostEntityId } : null;
}

function identityTransform(): Entity['components']['transform'] {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

export function getDevicePartDeclaration(
  scene: SceneDocument,
  entity: Entity,
): ModelSubDeviceConfig | null {
  const binding = entity.components.devicePartBinding;
  if (!binding) return null;
  const host = scene.entities[binding.hostEntityId];
  return (
    host?.components.modelAsset?.dataDrivenConfig?.subDevices?.find(
      (item) => item.role === binding.role,
    ) ?? null
  );
}

export type CompositeDeviceReconcileResult = {
  scene: SceneDocument;
  createdCount: number;
  warnings: string[];
};

/** 新版模型声明 subDevices 时幂等补齐逻辑设备；第二设备号由用户显式填写。 */
export function reconcileCompositeDevices(scene: SceneDocument): CompositeDeviceReconcileResult {
  const next = structuredClone(scene);
  const warnings: string[] = [];
  let createdCount = 0;
  const hosts = next.entityIds
    .map((id) => next.entities[id])
    .filter(
      (entity) => (entity?.components.modelAsset?.dataDrivenConfig?.subDevices?.length ?? 0) > 0,
    );

  for (const host of hosts) {
    const declarations = host.components.modelAsset!.dataDrivenConfig!.subDevices!;
    let folder = Object.values(next.entities).find(
      (entity) => entity.isFolder && entity.components.compositeDevice?.hostEntityId === host.id,
    );
    if (!folder) {
      folder = {
        id: createId('composite_device'),
        name: `${host.name}（复合设备）`,
        isFolder: true,
        visible: true,
        locked: false,
        parentId: host.parentId,
        childrenIds: [host.id],
        components: {
          transform: identityTransform(),
          compositeDevice: { hostEntityId: host.id },
        },
      };
      const hostIndex = next.entityIds.indexOf(host.id);
      next.entityIds.splice(Math.max(0, hostIndex), 0, folder.id);
      next.entities[folder.id] = folder;
      if (host.parentId) {
        const parent = next.entities[host.parentId];
        if (parent)
          parent.childrenIds = parent.childrenIds.map((id) => (id === host.id ? folder!.id : id));
      }
      next.entities[host.id].parentId = folder.id;
      createdCount++;
    }

    for (const declaration of declarations) {
      let part = Object.values(next.entities).find(
        (entity) =>
          entity.components.devicePartBinding?.hostEntityId === host.id &&
          entity.components.devicePartBinding.role === declaration.role,
      );
      if (!part) {
        part = {
          id: createId('device_part'),
          name: declaration.displayName,
          isFolder: false,
          visible: true,
          locked: false,
          parentId: folder.id,
          childrenIds: [],
          components: {
            transform: identityTransform(),
            devicePartBinding: { hostEntityId: host.id, role: declaration.role },
            telemetryBinding: createDefaultTelemetryBinding(
              declaration.device.devType ?? 'conveyor',
            ),
          },
        };
        next.entities[part.id] = part;
        const hostIndex = next.entityIds.indexOf(host.id);
        next.entityIds.splice(hostIndex + 1, 0, part.id);
        folder.childrenIds.push(part.id);
        createdCount++;
        warnings.push(
          `${host.name}：已创建「${declaration.displayName}」逻辑设备，请手动填写第二设备号 assetCode。`,
        );
      }
      if (part.parentId !== folder.id) {
        const previousParent = next.entities[part.parentId ?? ''];
        if (previousParent)
          previousParent.childrenIds = previousParent.childrenIds.filter((id) => id !== part!.id);
        part.parentId = folder.id;
        if (!folder.childrenIds.includes(part.id)) folder.childrenIds.push(part.id);
      }
      if (part.components.telemetryBinding?.deviceType !== declaration.device.devType) {
        part.components.telemetryBinding = createDefaultTelemetryBinding(
          declaration.device.devType ?? 'conveyor',
        );
      }
    }
  }

  return createdCount > 0
    ? { scene: next, createdCount, warnings }
    : { scene, createdCount: 0, warnings };
}
