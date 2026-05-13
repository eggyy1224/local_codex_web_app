export type ModelSelectOption = {
  value: string;
  label: string;
  isDefault: boolean;
};

export const DEFAULT_MODEL = "gpt-5.5";
export const LEGACY_DEFAULT_MODEL = "gpt-5.3-codex";
export const MODEL_STORAGE_KEY = "lcwa.model.v1";
export const MODEL_DEFAULT_MIGRATION_STORAGE_KEY = "lcwa.model.defaultMigration.v2";

export const FALLBACK_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: DEFAULT_MODEL, label: "GPT-5.5" },
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { value: "gpt-5-codex", label: "GPT-5-Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
];

export function shouldRestoreSavedModel(
  savedModel: string | null,
  defaultMigration: string | null,
): savedModel is string {
  return Boolean(
    savedModel && (savedModel !== LEGACY_DEFAULT_MODEL || defaultMigration === DEFAULT_MODEL),
  );
}

export function preferredModelOption(options: ModelSelectOption[]): ModelSelectOption | null {
  return (
    options.find((option) => option.value === DEFAULT_MODEL) ??
    options.find((option) => option.isDefault) ??
    options[0] ??
    null
  );
}
