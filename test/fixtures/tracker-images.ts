/**
 * How the trackers really answered for pictures, recorded 2026-11-18 against public items
 * (a gitlab.com project's merge request and a github.com issue). Only signatures and ids are
 * shortened; every shape (host, path, status, header, body start) is as it came.
 */

/** The first bytes of a real PNG as it arrived. */
export const PNG_START = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])

export const GITLAB = {
  host: 'gitlab.com',
  repo: 'gitlab-org/cli',
  projectId: 34675721,
  /** As the API gives a description: one upload relative to the project, one by project id. */
  description:
    '![sigstore](/uploads/62084dc44b7353be535c4eac94183551/glab-verify-self-managed-sigstore.png)\n'
    + '![local ca](/-/project/34675721/uploads/591c4990c5c80a55d9132fefdf41c787/glab-verify-self-managed-local-ca.png)\n'
    + '![shot](/uploads/f57dba427c6002748e01273a71a6a4dd/Screenshot_2026-11-11_at_7.54.23_PM.png)',
  /** `/uploads/…` read against the server root (what a page resolving against the item's address made of it). */
  atRoot: 'https://gitlab.com/uploads/62084dc44b7353be535c4eac94183551/glab-verify-self-managed-sigstore.png',
  /** …which is GitLab's sign-in page, not the picture: 302 to `/users/sign_in`, then HTML. */
  atRootAnswer: { status: 302, location: 'https://gitlab.com/users/sign_in', contentType: 'text/html; charset=utf-8' },
  /** The same upload under the project path, as a web route: 404 (HTML) on gitlab.com, sign-in on a private project. */
  inProject: 'https://gitlab.com/gitlab-org/cli/uploads/62084dc44b7353be535c4eac94183551/glab-verify-self-managed-sigstore.png',
  inProjectAnswer: { status: 404, contentType: 'text/html; charset=utf-8', bodyStart: '<!DOCTYPE html>' },
  /** The project-id form, as written in the text. */
  byId: 'https://gitlab.com/-/project/34675721/uploads/591c4990c5c80a55d9132fefdf41c787/glab-verify-self-managed-local-ca.png',
  /** What reads it: the API route, 200 `application/octet-stream`, PNG bytes. */
  api: 'projects/gitlab-org%2Fcli/uploads/62084dc44b7353be535c4eac94183551/glab-verify-self-managed-sigstore.png',
  apiById: 'projects/34675721/uploads/591c4990c5c80a55d9132fefdf41c787/glab-verify-self-managed-local-ca.png',
  apiAnswer: { status: 200, contentType: 'application/octet-stream' },
  /** `glab api` on an upload that is not there: exit 1, this on stderr, the JSON on stdout. */
  glabNotFound: { code: 1, err: 'glab: 404 Not Found (HTTP 404)', out: '{"message":"404 Not Found"}' },
} as const

export const GITHUB = {
  host: 'github.com',
  repo: 'oven-sh/bun',
  number: 48938,
  /** As an issue's Markdown has a pasted screenshot. */
  attachment: 'https://github.com/user-attachments/assets/82a87b90-18b3-493d-be0e-b84b3eb83d55',
  /** The older per-repository form. */
  repoAsset: 'https://github.com/oven-sh/bun/assets/38916225/0835add3-541e-4a51-8b80-68e4f2879336',
  /** Both redirect (302, no body) to GitHub's own bucket with a five-minute signature. */
  attachmentAnswer: {
    status: 302,
    location:
      'https://github-production-user-asset-6210df.s3.amazonaws.com/61796351/706362396-82a87b90-18b3-493d-be0e-b84b3eb83d55.png'
      + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261118%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261118T174855Z'
      + '&X-Amz-Expires=300&X-Amz-Signature=abc&X-Amz-SignedHeaders=host&response-content-type=image%2Fpng',
  },
  /** The same picture in the issue's `body_html` (`Accept: application/vnd.github.html+json`): a signed private-images address. */
  bodyHtml:
    '<p dir="auto">steps</p>\n<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="https://private-user-images.githubusercontent.com/61796351/706362396-82a87b90-18b3-493d-be0e-b84b3eb83d55.png?jwt=eyJ0eXAi.x.y">'
    + '<img width="575" height="478" alt="image" src="https://private-user-images.githubusercontent.com/61796351/706362396-82a87b90-18b3-493d-be0e-b84b3eb83d55.png?jwt=eyJ0eXAi.x.y&amp;v=1" style="max-width: 100%;"></a></p>',
} as const
