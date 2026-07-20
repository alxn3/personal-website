import { defineCollection, reference } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";

const projects = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/projects" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    summary: z.string(),
    // demo location: an external URL or an internal path (e.g. "/lens")
    url: z.string().optional(),
    repo: z.url().optional(),
    tags: z.array(z.string()).default([]),
    icon: z.string().default("lucide:box"),
    date: z.coerce.date(),
  }),
});

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    projects: z.array(reference("projects")).default([]),
  }),
});

export const collections = { projects, blog };
