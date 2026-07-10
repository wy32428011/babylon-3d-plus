/** 注册受控 MQTT IPC 通道；多次调用只会注册一次，避免热重载或测试重复绑定。 */
export declare function registerMqttIpc(): void;
/** 清理所有 renderer 对应的 MQTT 客户端，供 app will-quit 生命周期调用。 */
export declare function disposeAllMqttIpcClients(): void;
