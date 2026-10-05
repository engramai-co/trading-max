import test from "node:test";
import assert from "node:assert/strict";
import { releasePresentation } from "../splash/releases.mjs";

test("a newer source release is not presented as an installable app", () => {
  const view = releasePresentation({version:"1.12.0", desktop:null});
  assert.equal(view.download, false);
  assert.match(view.message, /尚无.*桌面安装包/);
  assert.doesNotMatch(view.message, /已经是最新|有新版本可下载/);
});
test("desktop and repository versions stay distinct; reinstall is explicit and downgrade is absent", () => {
  for (const relation of ["newer","same","older"]) {
    const view = releasePresentation({version:"1.12.0",desktop:{version:"1.11.0",relation,size:104857600,sha256:"a".repeat(64)}});
    assert.match(view.message,/桌面版 v1.11.0/);
    assert.match(view.message,/仓库稳定版为 v1.12.0/);
    assert.equal(view.download, relation !== "older");
    if (relation === "same") assert.match(view.label,/重新下载/);
    assert.match(view.details,/100.0 MB/);
  }
});
test("in-app installation needs a newer signed-feed release; old DMGs remain manual", () => {
  for (const relation of ["newer", "same", "older"]) {
    for (const in_app of [true, false, undefined]) {
      const view = releasePresentation({version:"1.12.0", desktop:{version:"1.12.0",relation,size:100,sha256:"a".repeat(64),in_app}});
      assert.equal(view.inApp, relation === "newer" && in_app === true);
    }
  }
});
