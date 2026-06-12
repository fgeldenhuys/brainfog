# Spec: <Feature Name>

## Blueprint

### Context

<Why this feature exists, what problem it solves, and who or what depends on it. Reference the relevant sections of `VISION.md`, `ARCHITECTURE.md`, and any ADRs that constrain or motivate this work.>

### Architecture

- **API Contracts**: <New or changed `/api/v1/*` routes and/or `/mcp` tools — request/response shapes, auth requirements, error cases.>
- **Data Models**: <New or changed D1 tables/columns (Drizzle schema), Vectorize index changes, and how they relate to existing data.>
- **Dependencies**: <New packages, Cloudflare bindings, or external services this feature requires. Anything outside the scope of an existing ADR needs a new ADR per `AGENTS.md`'s "ASK" rules before implementation.>
- **Constraints**: <Invariants from `ARCHITECTURE.md` and relevant ADRs that this feature must respect.>

## Contract

### Definition Of Done

- [ ] <Concrete, checkable outcome>
- [ ] <Concrete, checkable outcome>

### Regression Guardrails

- <Existing behavior that must not break as a result of this work, and how it is verified (test name/suite, or manual check).>

### Scenarios

```gherkin
Feature: <Feature Name>

  Scenario: <Scenario name>
    Given <precondition>
    When <action>
    Then <observable outcome>
```
