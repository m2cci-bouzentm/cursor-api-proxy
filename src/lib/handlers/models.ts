import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import type { CursorCliModel } from "../cursor-cli.js";
import { listCursorCliModels } from "../cursor-cli.js";
import { json } from "../http.js";

const MODEL_CACHE_TTL_MS = 5 * 60_000;

export type ModelCache = { at: number; models: CursorCliModel[] };
export type ModelCacheRef = {
  current?: ModelCache;
  inflight?: Promise<CursorCliModel[]>;
};

export type HandleModelsOpts = {
  config: BridgeConfig;
  modelCacheRef: ModelCacheRef;
};

export async function getCachedCursorModels(
  config: BridgeConfig,
  modelCacheRef: ModelCacheRef,
): Promise<CursorCliModel[]> {
  const now = Date.now();
  if (
    !modelCacheRef.current ||
    now - modelCacheRef.current.at > MODEL_CACHE_TTL_MS
  ) {
    // Deduplicate concurrent fetches — reuse a single in-flight promise
    if (!modelCacheRef.inflight) {
      modelCacheRef.inflight = listCursorCliModels({
        agentBin: config.agentBin,
        timeoutMs: 60_000,
      }).then(
        (models) => {
          // Never cache an empty catalog — usually a parse/env glitch
          // (e.g. colored CLI output) and would poison /v1/models for TTL.
          if (models.length > 0) {
            modelCacheRef.current = { at: Date.now(), models };
          }
          modelCacheRef.inflight = undefined;
          return models;
        },
        (err) => {
          modelCacheRef.inflight = undefined;
          throw err;
        },
      );
    }
    await modelCacheRef.inflight;
  }
  return modelCacheRef.current?.models ?? [];
}

export async function handleModels(
  res: http.ServerResponse,
  opts: HandleModelsOpts,
): Promise<void> {
  const { config, modelCacheRef } = opts;
  const models = (await getCachedCursorModels(config, modelCacheRef))
    .filter((model) => !/claude|codex|gpt|^(auto|default)$/i.test(model.id))
    .sort(
      (a, b) =>
        Number(!a.id.toLowerCase().includes("grok")) -
          Number(!b.id.toLowerCase().includes("grok")) ||
        a.id.localeCompare(b.id),
    );
  const cursorModels = models.map((m) => ({
    id: m.id,
    object: "model" as const,
    owned_by: "cursor" as const,
    name: m.name,
  }));
  json(res, 200, {
    object: "list",
    data: cursorModels,
  });
}
