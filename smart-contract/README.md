# Smart contract skeletons

Weekly milestone: define the data models, events, and planned APIs from Design.pdf.

- `ParticipantRegistry.sol`: facilities, participants, roles, and credential eligibility.
- `MedicalAccessController.sol`: record metadata, consent, emergency requests, access authorization, and reviews.

Both contracts contain declarations and stubs. Declared business functions revert with `NotImplemented()`. The registry constructor also reverts; the controller constructor only stores its immutable registry reference. Deployment workflow, business logic, and tests are deferred. Comments are kept minimal.

From this directory, using Node.js 24 LTS:

```sh
npm ci
npm run compile
```

Unused-parameter warnings are expected for the stubs. Function mutability will be updated when implementation begins.
