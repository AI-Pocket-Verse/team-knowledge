import { z } from "zod";

// displayName is intentionally NOT editable here: it is SSO-sourced
// (Feishu) and read-only across the app, so the admin user-edit form only
// toggles admin/active and role assignment.
export const adminUserUpdateSchema = z
  .object({
    isAdmin: z.boolean().optional(),
    isActive: z.boolean().optional(),
    roleIds: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "至少需要一个字段" });
export type AdminUserUpdateInput = z.infer<typeof adminUserUpdateSchema>;

const ROLE_COLOR_KEYS = ["violet", "pink", "blue", "amber", "green", "teal", "rose", "slate"] as const;
const colorSchema = z.enum(ROLE_COLOR_KEYS).nullable().optional();

export const roleCreateSchema = z.object({
  name: z.string().min(1).max(32),
  description: z.string().max(255).nullable().optional(),
  color: colorSchema,
});
export type RoleCreateInput = z.infer<typeof roleCreateSchema>;

export const roleUpdateSchema = z
  .object({
    name: z.string().min(1).max(32).optional(),
    description: z.string().max(255).nullable().optional(),
    color: colorSchema,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "至少需要一个字段" });
export type RoleUpdateInput = z.infer<typeof roleUpdateSchema>;
