# Generators, per stack

Reference for `/scaffold-run`. **Check `--help` before using any flag here** —
this table names the tool, not its current interface, and a flag that moved is
exactly the failure this skill exists to avoid.

## Web

| Stack | Generator |
|---|---|
| React SPA | `npm create vite@latest <name> -- --template react-ts` |
| Next.js | `npx create-next-app@latest <name>` |
| Remix / React Router | `npx create-react-router@latest <name>` |
| Astro | `npm create astro@latest <name>` |
| SvelteKit | `npx sv create <name>` |
| Nuxt | `npx nuxi@latest init <name>` |
| Angular | `npx @angular/cli@latest new <name>` |
| SolidStart | `npm create solid@latest` |

## Backend

| Stack | Generator |
|---|---|
| Express | `npx express-generator` — dated; prefer a typed framework unless the brief asks |
| NestJS | `npx @nestjs/cli new <name>` |
| Fastify | `npm create fastify@latest` |
| Hono | `npm create hono@latest` |
| Django | `django-admin startproject <name>` |
| Rails | `rails new <name>` |
| Spring Boot | `curl https://start.spring.io/starter.zip -d ...` (Spring Initializr) |
| Go | `go mod init <module>` — no generator; the layout is yours |

## Mobile

| Stack | Generator |
|---|---|
| React Native (Expo) | `npx create-expo-app@latest <name>` |
| React Native (bare) | `npx @react-native-community/cli@latest init <name>` |
| Flutter | `flutter create <name>` |
| Native iOS | Xcode template — no CLI generator worth the name |
| Native Android | Android Studio template, or `gradle init` |
| KMP | `kdoctor` first, then the Kotlin Multiplatform wizard |

## Full-stack, opinionated

| Stack | Generator | Note |
|---|---|---|
| T3 (Next + tRPC + Prisma) | `npm create t3-app@latest` | Prompts for each piece; record what you answered |
| RedwoodJS | `npx create-redwood-app@latest <name>` | |
| Blitz | `npx blitz new <name>` | |

## What no generator gives you

Every one of these leaves the same holes, and they are what
`/architecture-apply` exists for:

- **Layering** — a generator gives folders, not a direction of dependency
- **A composition root** — nothing wires the app in one place, so nothing can
  wire it differently for a test
- **A real test** — most give you a placeholder that asserts the placeholder
- **Validation at the edges** — untrusted data is trusted inward by default
- **An enforceable rule** — no generator ships a dependency-cruiser config

## MERN specifically

There is no `create-mern-app` worth running, and that is a useful fact rather
than a gap: MERN is four separate decisions, so it is four separate generator
runs — the client, the server, and two choices (Mongo, Express) that are made
by *installing* rather than generating.

Run the client and server generators separately, in their own directories, and
say plainly whether they share a repository. That answer decides the tooling
every later contributor has to learn, and it is a decision, not a default.
