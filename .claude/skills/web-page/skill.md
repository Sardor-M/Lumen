---
name: web-page
description: Scaffold a new page or component for the Lumen Next.js web app. TRIGGER when user asks to create, add, or build a new page, route, or dashboard section.
---

# Scaffold Web Page

Create new pages and components for `apps/web/` following the project's conventions.

## Before Scaffolding

1. Check existing routes in `apps/web/src/app/dashboard/`
2. Check existing components in `apps/web/src/components/`
3. Read `CLAUDE.md` — especially the `apps/web/` rules

## Key Rules

- **Default exports** only for Next.js framework files: `page.tsx`, `layout.tsx`, `error.tsx`, `loading.tsx`, `route.ts`
- **`export function`** for everything else — components, lib, utils
- **`'use client'`** only when you need hooks or event handlers
- **shadcn base-ui uses `render` prop, NOT `asChild`**: `<SidebarMenuButton render={<Link href="..." />}>`
- **Zod schemas** in `src/lib/schemas.ts` for all form inputs
- **Session check** in server components: `auth.api.getSession({ headers: await headers() })`

## Page Template

```tsx
// apps/web/src/app/dashboard/<name>/page.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function PageName() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Page Title</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    Description of what this page shows.
                </p>
            </div>
            {/* Content here */}
        </div>
    );
}
```

## Gotchas

- shadcn components use `@base-ui/react` primitives, not Radix. Don't use `asChild` — it leaks to DOM.
- `cn()` from `@/lib/utils` for all className merging
- Tailwind v4 — uses `@theme inline {}` in `globals.css`, not `tailwind.config.ts`
- The sidebar nav items are in `src/components/app-sidebar.tsx` — add new routes there too
- Protected routes live under `app/dashboard/` which has a layout with session gate
