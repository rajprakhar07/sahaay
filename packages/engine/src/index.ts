import { z } from "zod";

// ---------- Shared primitives ----------

export const IdSchema = z.string().trim().min(1).max(64);

export const NonEmptyTextSchema = z.string().trim().min(1).max(300);

export const NonNegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const PositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

// ---------- People ----------

export const PersonSchema = z.object({
  id: IdSchema,
  name: NonEmptyTextSchema,
  skills: z.array(NonEmptyTextSchema).default([]),
  available: z.boolean(),
});

export type Person = z.infer<typeof PersonSchema>;

// ---------- Locations ----------

export const LocationSchema = z.object({
  id: IdSchema,
  name: NonEmptyTextSchema,
  description: z.string().trim().max(500).default(""),
});

export type Location = z.infer<typeof LocationSchema>;

// ---------- Resources ----------

export const ResourceKindSchema = z.enum(["consumable", "reusable"]);

export const ResourceSchema = z.object({
  id: IdSchema,
  name: NonEmptyTextSchema,
  kind: ResourceKindSchema,
  quantity: NonNegativeIntegerSchema,
  unit: NonEmptyTextSchema,
  locationId: IdSchema.optional(),
});

export type Resource = z.infer<typeof ResourceSchema>;

export const ResourceRequirementSchema = z.object({
  resourceId: IdSchema,
  quantity: PositiveIntegerSchema,
});

export type ResourceRequirement = z.infer<typeof ResourceRequirementSchema>;

// ---------- Tasks ----------

export const TaskPrioritySchema = z.enum(["low", "medium", "high", "critical"]);

export const TaskSchema = z.object({
  id: IdSchema,
  title: NonEmptyTextSchema,
  description: z.string().trim().max(1000).default(""),
  priority: TaskPrioritySchema,
  required: z.boolean().default(true),
  estimatedMinutes: PositiveIntegerSchema,
  assignedPersonId: IdSchema.optional(),
  requiredSkills: z.array(NonEmptyTextSchema).default([]),
  resourceNeeds: z.array(ResourceRequirementSchema).default([]),
  locationId: IdSchema.optional(),
  dependsOnTaskIds: z.array(IdSchema).default([]),
});

export type Task = z.infer<typeof TaskSchema>;

// ---------- Complete household plan ----------

export const HouseholdPlanSchema = z
  .object({
    id: IdSchema,
    people: z.array(PersonSchema),
    tasks: z.array(TaskSchema),
    resources: z.array(ResourceSchema),
    locations: z.array(LocationSchema),
  })
  .superRefine((plan, ctx) => {
    // 1. Duplicate IDs within each collection.
    const collections: ReadonlyArray<
      readonly [string, ReadonlyArray<{ id: string }>]
    > = [
      ["people", plan.people],
      ["tasks", plan.tasks],
      ["resources", plan.resources],
      ["locations", plan.locations],
    ];

    for (const [collectionName, items] of collections) {
      const seen = new Set<string>();

      items.forEach((item, index) => {
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: "custom",
            path: [collectionName, index, "id"],
            message: `Duplicate ${collectionName} ID "${item.id}"`,
          });
        }
        seen.add(item.id);
      });
    }

    // 2. Lookup sets for cross-reference checks.
    const peopleIds = new Set(plan.people.map((person) => person.id));
    const taskIds = new Set(plan.tasks.map((task) => task.id));
    const resourceIds = new Set(plan.resources.map((resource) => resource.id));
    const locationIds = new Set(plan.locations.map((location) => location.id));

    // 3. Task cross-references.
    plan.tasks.forEach((task, index) => {
      if (task.assignedPersonId && !peopleIds.has(task.assignedPersonId)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "assignedPersonId"],
          message: `Unknown person ID "${task.assignedPersonId}"`,
        });
      }

      if (task.locationId && !locationIds.has(task.locationId)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "locationId"],
          message: `Unknown location ID "${task.locationId}"`,
        });
      }

      task.resourceNeeds.forEach((need, needIndex) => {
        if (!resourceIds.has(need.resourceId)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "resourceNeeds", needIndex, "resourceId"],
            message: `Unknown resource ID "${need.resourceId}"`,
          });
        }
      });

      task.dependsOnTaskIds.forEach((dependencyId, dependencyIndex) => {
        if (!taskIds.has(dependencyId)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "dependsOnTaskIds", dependencyIndex],
            message: `Unknown task ID "${dependencyId}"`,
          });
        }

        if (dependencyId === task.id) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "dependsOnTaskIds", dependencyIndex],
            message: "A task cannot depend on itself",
          });
        }
      });
    });

    // 4. Resource cross-references.
    plan.resources.forEach((resource, index) => {
      if (resource.locationId && !locationIds.has(resource.locationId)) {
        ctx.addIssue({
          code: "custom",
          path: ["resources", index, "locationId"],
          message: `Unknown location ID "${resource.locationId}"`,
        });
      }
    });
  });

export type HouseholdPlan = z.infer<typeof HouseholdPlanSchema>;