# Flocked

A daily minority game. One question, two options, picks sealed until a fixed reveal time; the side
fewer people picked wins the other side's stakes.

- Product spec: [Product_Spec.md](Product_Spec.md)
- Design language: [Design_Language.md](Design_Language.md)
- Implementation plan: [plan.md](plan.md)

## Setup

Requires Node 20.19+ and pnpm 10 (`corepack enable` picks up the pinned version).

```bash
pnpm install
pnpm check
```

## Layout

| Path              | What                                                     |
| ----------------- | -------------------------------------------------------- |
| `apps/*`          | Web client and Workers (from later waves)                |
| `packages/shared` | `@flocked/shared`: enums and brand copy                  |
| `contracts/`      | Foundry project (`FlockedEscrow`, `FlockedAnchor`)       |
| `scripts/`        | Repo scripts, see [scripts/README.md](scripts/README.md) |
| `docs/`           | Plan waves, session prompts and handoffs                 |
