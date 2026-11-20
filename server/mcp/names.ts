/**
 * Every tool the host's door answers, by name. The order is the one a refusal for an unknown tool
 * lists them in (`mcp` in `server/mcp.ts`); the order `tools/list` gives them in is the registry's
 * (`registry.ts`).
 */
export const TOOL_NAMES = [
  'read_canvas',
  'select_modules',
  'place_modules',
  'create_epic',
  'set_parts',
  'edit_space',
  'mark_disposition',
  'read_tracker',
  'set_tracker_source',
  'module_versions',
  'pin_version',
  'fold_modules',
  'arrange_modules',
  'press_item',
  'jump',
  'offer_jump',
  'propose_adoption',
  'open_address',
  'read_inbox',
  'my_place',
  'set_my_place',
  'storage',
  'read_logs',
  'module_settings',
  'kehikko_skills',
  'create_kehikko',
  'send_message',
  'read_messages',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]
