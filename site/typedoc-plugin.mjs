// API 參考（SDK ADR 0115）：模組名稱改成使用方 import 的寫法（`@cinderous/client/relay/node`）。
import { Converter, ReflectionKind } from 'typedoc';
import { importPath } from './typedoc.config.mjs';

export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const mod of context.project.getReflectionsByKind(ReflectionKind.Module)) mod.name = importPath(mod.name);
  });
}
