/* 服务调用（与服务面板共用，抽出来避免循环依赖） */

import { Service } from "foxglove-ros-adapter";

/** 把服务类型名转成对应的 request 类型，如 srv/ATBool → srv/ATBool_Request */
export function normalizeRequestType(serviceType) {
  if (!serviceType) return "";
  return serviceType.endsWith("_Request") ? serviceType : `${serviceType}_Request`;
}

/**
 * 带超时的单次服务调用。
 * 适配器的 callService 是回调式（request, onSuccess, onError），这里包成 Promise。
 */
export function callServiceOnce(ros, name, serviceType, request, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`调用超时（${timeoutMs} ms）— 该服务可能未被节点提供`));
    }, timeoutMs);

    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };

    try {
      const svc = new Service({
        ros,
        name,
        serviceType: normalizeRequestType(serviceType),
      });
      svc.callService(request ?? {}, (res) => settle(resolve, res), (err) => settle(reject, err));
    } catch (e) {
      settle(reject, e);
    }
  });
}
