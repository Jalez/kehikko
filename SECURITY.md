# Security

If you find a security problem in Kehikot, the host, the protocol or any
module, please report it privately: open the repository's **Security** tab
and choose **Report a vulnerability**. Please don't open a public issue.

Include what you found, how to reproduce it, and what it could let someone
do. You'll get an answer as soon as possible.

Kehikot runs locally and modules run with the permissions of the person using
the app, so problems worth reporting include: a module or web page reaching
what it was not granted, data written outside a project's `.kehikot/` folder,
anything that lets a pull request, a list entry or a release reach other
people's machines without the maintainer, and anything touching the update
signing.
