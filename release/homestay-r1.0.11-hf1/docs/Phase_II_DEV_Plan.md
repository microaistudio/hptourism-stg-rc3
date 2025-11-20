# Phase II Development Plan

Living roadmap for the next engineering cycle. Update this document as new requirements surface or priorities shift.

## 1. Refactor `routes.ts`
- Split the monolithic Express router into domain modules (auth, admin, HimKosh, applications, staff, utilities).
- Keep existing endpoints stable; only internal wiring changes.
- Add targeted tests for each module before moving on to the next.

## 2. Client & Server Code Restructure
- Server: adopt consistent folder layout (`routes/`, `services/`, `middleware/`, `controllers/`).
- Client: organize features by domain (Admin, HimKosh, Applications, etc.), keeping shared UI/components in dedicated directories.
- Document the new structure for onboarding and future contributors.

## 3. UI Refactoring
- Consolidate reusable patterns (cards, tables, forms) into a common library.
- Reduce duplication across admin dashboards and owner screens.
- Align styling/tokens with the design system to simplify theming and future refreshes.

## 4. Testing Framework Integration
- **Server**: Jest + Supertest for unit/integration coverage.
- **Client**: React Testing Library for component tests.
- **E2E**: Playwright or Cypress to cover full workflows (owner submission, payment, admin approval).
- Wire the suites into CI so every PR runs lint + tests automatically.

---

_Add additional initiatives here as new ideas and requirements emerge._
