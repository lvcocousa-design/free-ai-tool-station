# Contributing

Thanks for helping improve the Free AI Tool Station! This project is a
self-hosted app that runs entirely on each provider's free tier. Please read
the notes below before contributing.

## Run locally

Requirements: Node.js >= 18.

```bash
# Install dependencies
npm install

# Configure environment variables (fill in only the providers you need;
# unused ones can be left empty)
cp .env.example .env

# Start the server, then open http://localhost:8080
npm start
```

See [README_EN.md](README_EN.md) for the full feature list, the
environment-variable table, and how to get each provider's API key.

## Extending the app

To add a provider, add a feature tab, or change model configuration, see
the extending guide: [docs/EXTENDING.md](docs/EXTENDING.md) (Chinese) and
[docs/EXTENDING_EN.md](docs/EXTENDING_EN.md) (English).

## How to submit a pull request

1. Fork this repository and create a branch from `main`
   (e.g. `git checkout -b fix/translation-typo`).
2. Make your change. Keep it focused — one fix or feature per PR.
3. Test it locally: run the test suite (`npm test`, no network needed)
   and confirm the app still starts (`npm start`) and the affected
   feature works.
4. Update [CHANGELOG.md](CHANGELOG.md): add your change under
   `[Unreleased]` before opening the PR.
5. Open a pull request against `main`. In the PR description, say clearly:
   - what you changed and why;
   - how you verified it (commands run, what you tested, screenshots for
     UI changes).

## Notes

- **Never commit real API keys, tokens, or passwords.** Use placeholders
  such as `YOUR_GROQ_API_KEY_HERE` in docs and examples.
- **`.env` and `data/` never go into the repository.** Both are ignored by
  `.gitignore` — `.env` holds real keys, and `data/` holds history,
  sessions, settings, and generated files.
- **Free tiers only.** New features must work within providers' free
  quotas — do not add anything that requires a paid plan or a bound card.
- **Discuss new features first.** Before adding a feature, please open an
  issue describing what you want to add and how it fits the project, so
  we can agree on the approach before you write code.
- **Keep the Chinese and English docs in sync.** When you change
  `README.md` or `docs/EXTENDING.md`, update `README_EN.md` or
  `docs/EXTENDING_EN.md` to match, and vice versa. The environment
  variable table, the feature list, and the test-coverage paragraph must
  match `.env.example` and the actual code.
- **Don't break existing features.** Changes should keep all current tabs
  and providers working; if a change affects behavior, say so in the PR.
