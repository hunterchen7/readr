# CLAUDE.md — Project Guidelines

> These rules apply to every coding session. Follow them strictly.

## Source of Truth

The implementation spec is `ebook-reader-architecture.md`. Always consult it before making architectural decisions. If something in the codebase contradicts the spec, the spec wins unless the user says otherwise.

## Development Workflow

### Commit Discipline
- **Commit after every meaningful step.** Each numbered step within a phase (e.g., Phase 1 step 3: "Set up apps/server") gets its own commit.
- Write clear, concise commit messages that describe *what* was done, not *how*.
- Never bundle unrelated changes into a single commit.
- Do not commit broken code. Every commit should leave the project in a buildable state.

### Validate Before Moving On
- Before moving to the next step, verify the current step actually works: run the dev server, test the endpoint, confirm the UI renders, etc.
- Before moving to the next phase, do a full smoke test of everything built so far.
- If something is broken, fix it before proceeding. Do not accumulate tech debt across steps.

### Phase Tracking
- At the start of each phase, note which phase and step you're on.
- Reference the spec's phase numbers (e.g., "Phase 1, step 3") in commits and conversation.

## Code Quality

### General
- Keep it simple. Solve the current problem, not hypothetical future ones.
- Prefer editing existing files over creating new ones.
- Delete dead code. Don't leave commented-out blocks, unused imports, or placeholder functions.
- Use the types and validators from `packages/shared` — don't redefine them locally.
- Validate at system boundaries (API inputs, user input). Trust internal code.
- Handle errors where they matter. Don't wrap every call in try/catch — let unexpected errors propagate and crash loudly in dev.

### React & React Native

**Component Patterns:**
- Functional components only. No class components.
- Colocate related code: keep a component's styles, types, and helpers near the component, not in distant utility files.
- Keep components small and focused. If a component file exceeds ~200 lines, consider splitting it.
- Use Expo's file-based routing conventions. Don't fight the framework.

**State Management:**
- Use `zustand` for global client state. Use React Query for server state. Don't mix them.
- Minimize `useEffect`. Derive state from props/query data instead of syncing with effects.
- Use functional `setState` updates (`setCount(c => c + 1)`) for stable callbacks that don't need the value in the render closure.
- Use lazy state initialization (`useState(() => expensiveComputation())`) when initial state is expensive to compute.
- Subscribe to derived booleans from zustand (`useStore(s => s.items.length > 0)`) instead of raw collections to reduce re-renders.
- Don't read store state you only use inside callbacks — use `useStore.getState()` instead.

**Performance (from [Vercel React Best Practices](https://github.com/vercel/react-best-practices)):**
- **Eliminate async waterfalls (CRITICAL):** Use `Promise.all()` for independent async operations. Never `await` sequentially when operations don't depend on each other. Defer `await` into branches where actually needed.
- **Avoid barrel file imports (CRITICAL):** Import directly from source files (`import Button from '@mui/material/Button'`), not barrel re-exports (`import { Button } from '@mui/material'`). This avoids loading thousands of unused modules.
- **Lazy-load heavy components:** Use `React.lazy()` + `<Suspense>` for components not needed on initial render (e.g., the ebook reader WebView, settings panels). Preload on hover/focus for perceived speed.
- **Conditional module loading:** Use dynamic `import()` to load large modules only when a feature is activated.
- **Use `startTransition` for non-urgent updates:** Wrap expensive state updates (e.g., filtering a large book list) in `startTransition` to keep the UI responsive.
- Memoize expensive computations with `useMemo`, not renders. Avoid premature `React.memo` — only add it when you've measured a performance problem.
- Extract static JSX outside components to avoid re-creating on every render.
- Use ternary (`condition ? <A /> : null`) not `&&` (`condition && <A />`) — avoids rendering `0` or `""` for falsy non-boolean values.
- Use `content-visibility: auto` in CSS for long scrollable lists (web only).

**JavaScript Performance:**
- Use `Set`/`Map` for O(1) lookups instead of `Array.includes()` or `Array.find()` in hot paths.
- Combine chained `.filter().map()` into a single loop when processing large arrays.
- Cache property access in tight loops (`const len = arr.length`).
- Use `toSorted()` / `toReversed()` for immutable array operations.
- Early return from functions to avoid deep nesting.

### TypeScript
- Strict mode. No `any` unless interfacing with an untyped library (and even then, cast as narrowly as possible).
- Prefer `interface` for object shapes, `type` for unions/intersections.
- Infer types from Drizzle schema and Zod validators rather than manually defining duplicate types.
- Use Zod schemas from `packages/shared/validators.ts` for all API request/response validation.

### Backend (Hono)
- Every route handler must use `c.get("userId")` for the authenticated user — never trust client-supplied user IDs.
- Use the `scopeToUser` helpers for all data queries. No exceptions.
- Keep route files thin: business logic goes in `services/`, data access uses Drizzle directly.
- Use Zod OpenAPI decorators for all endpoints so the API spec stays auto-generated.

### CSS / Styling
- Mobile: use React Native's `StyleSheet.create` or inline styles. No CSS-in-JS libraries.
- Web: Tailwind CSS utility classes. Use shadcn/ui components. Avoid custom CSS unless absolutely necessary.
- E-ink: always test that new UI looks acceptable with `isEink: true` (high contrast, no animations, no color).

## Testing

- **Never write tests just for coverage.** Every test must validate behavior that matters.
- Focus tests on: API endpoints (request/response contracts), sync engine merge logic, and any non-trivial data transformations.
- Don't test React component rendering unless the component has complex conditional logic. Snapshot tests are almost never useful.
- Integration tests > unit tests for API routes. Use a real test database, not mocks.
- For the sync engine (`packages/sync-engine`), thorough unit tests are actually valuable — edge cases in LWW and tombstone sets matter.

## Project Structure

Follow the monorepo structure from the spec exactly:
- `apps/mobile` — React Native (Expo)
- `apps/web` — React + Vite
- `apps/server` — Hono API
- `packages/shared` — shared types, constants, Zod validators
- `packages/sync-engine` — isomorphic sync logic
- `services/tts-worker` — Python TTS service
- `deploy/` — Docker, Caddy, Helm

Don't create new top-level directories or packages without discussing it first.

## Dependencies

- Check if a dependency already exists in the spec's package lists before adding a new one.
- Prefer small, focused packages over large frameworks.
- Never add a dependency for something that can be done in <20 lines of code.
- Pin Expo SDK-compatible versions for all React Native packages (check `expo install` compatibility).

## Git & Branching

- Work on `main` for now (single developer). Branch when needed for experiments.
- Commit messages format: `phase X.Y: description` (e.g., `phase 1.3: set up hono server with auth and s3`)
- Don't push to remote unless asked.

## Common Pitfalls to Avoid

- Don't add `expo-dev-client` or eject from managed workflow unless a native module absolutely requires it.
- Don't over-abstract the WebView bridge. The postMessage protocol between RN and reader WebViews should be simple JSON — no RPC framework.
- Don't prematurely optimize the sync engine. LWW + tombstone sets are intentionally simple.
- Don't forget that the Supernote is an e-ink device. Every UI change should be mentally checked against e-ink constraints (no animations, no color, large tap targets).
- Remember R2 presigned URLs are publicly routable — don't accidentally double-proxy them through the API server.
