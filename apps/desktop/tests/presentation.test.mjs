import test from "node:test";
import assert from "node:assert/strict";
import { workspacePresentation, savedRemote } from "../splash/presentation.mjs";

test("an active local workspace never inherits the saved remote service identity", () => {
  const view = workspacePresentation({
    mode: "local", stage: "ready", workspace: { name: "Synthetic local", path: "/tmp/synthetic workspace" },
    profile: { name: "Saved server", url: "https://saved.example.test/" },
  });
  assert.equal(view.name, "Synthetic local");
  assert.equal(view.address, "/tmp/synthetic workspace");
  assert.equal(view.canRevealFolder, true);
  assert.equal(view.settingsLabel, "工作区设置");
  assert.match(view.ownership, /本地采集暂停/);
});

test("an offline service keeps the selected identity but disables service navigation", () => {
  const view = workspacePresentation({
    mode: "remote", stage: "error", active_name: null, active_url: null,
    source_name: "Selected server", source_address: "https://selected.example.test/",
    profile: { name: "Different saved server", url: "https://saved.example.test/" },
  });
  assert.equal(view.ready, false);
  assert.equal(view.status, "连接中断");
  assert.equal(view.name, "Selected server");
  assert.equal(view.address, "selected.example.test");
  assert.equal(view.canRevealFolder, false);
  assert.equal(view.settingsLabel, "服务端设置");
});

test("connection readiness is not presented as successful collection", () => {
  const view = workspacePresentation({ mode: "remote", stage: "ready", probe: { healthy: true } });
  assert.equal(view.status, "已连接");
  assert.match(view.detail, /资料完整性.*同步与活动/);
  assert.doesNotMatch(view.detail, /任务成功|数据正常/);
  const degraded = workspacePresentation({ mode: "remote", stage: "ready", probe: { healthy: true, worker_healthy: false } });
  assert.equal(degraded.ready, true);
  assert.match(degraded.detail, /后台更新状态需要检查/);
});

test("demo and idle sessions do not offer a real data folder or saved-server identity", () => {
  for (const state of [{ mode: "demo", stage: "ready" }, { mode: null, stage: "idle" }]) {
    const view = workspacePresentation({ ...state, profile: { name: "Private server", url: "https://saved.example.test/" } });
    assert.equal(view.canRevealFolder, false);
    assert.equal(view.address, "");
    assert.notEqual(view.name, "Private server");
  }
  assert.equal(savedRemote({ mode: "demo", url: "https://saved.example.test/" }), false);
  assert.equal(savedRemote({ mode: "remote", url: "" }), false);
  assert.equal(savedRemote({ mode: "remote", url: "https://saved.example.test/" }), true);
});
