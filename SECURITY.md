# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use [GitHub's private security advisory](https://github.com/yuga-hashimoto/claw-auto-router/security/advisories/new) to report vulnerabilities confidentially.

Please include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

### What to expect

1. **Acknowledgement** within 48 hours
2. **Assessment** within 7 days — we'll confirm whether it's a valid vulnerability and its severity
3. **Fix** — we'll work on a patch and coordinate a disclosure timeline with you
4. **Credit** — reporters are credited in the release notes (unless you prefer to remain anonymous)

## Scope

In scope:
- Authentication / authorization bypass
- Injection vulnerabilities (via config, API requests)
- Sensitive data exposure (API keys, tokens)
- Remote code execution via crafted requests

Out of scope:
- Denial of service against self-hosted instances
- Issues requiring physical access to the host machine
- Security issues in upstream dependencies (report directly to the dependency maintainer)
