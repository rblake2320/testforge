# Contributing to TestForge

Thanks for your interest in contributing to TestForge.

## Getting Started

1. Fork the repository
2. Create a feature branch from `master`
3. Make your changes
4. Run tests locally before pushing
5. Open a pull request

## Development Setup

### TestForge Framework (Java)
```bash
cd Documents/hello-world
mvn clean test -Dcucumber.filter.tags="@smoke"
```

### SeleniumForge Extension (Chrome)
1. Navigate to `chrome://extensions/`
2. Enable Developer mode
3. Click "Load unpacked" and select the `selenium-forge/` directory
4. Make changes and click the refresh icon on the extension card

## Code Style

- **Java**: Follow standard Java conventions. Use meaningful variable names.
- **JavaScript**: No framework required. Use `'use strict'` in all files. Prefer `const` over `let`.
- **HTML/CSS**: Semantic HTML. CSS custom properties for theming.

## Commit Messages

Use conventional commit prefixes:
- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `test:` — adding or updating tests
- `ci:` — CI/CD changes
- `refactor:` — code restructuring without behavior change

## Pull Requests

- Keep PRs focused on a single change
- Reference any related issues
- Ensure CI passes before requesting review

## Reporting Issues

Use GitHub Issues. Include:
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS/Java version where relevant
- Screenshots if applicable

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
