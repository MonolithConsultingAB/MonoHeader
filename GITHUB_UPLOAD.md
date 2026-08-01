# Upload MonoHeader to GitHub

The source archive is a complete repository working tree. It intentionally
excludes generated dependencies, test reports, and release output.

## Recommended: push with Git

1. Extract `monoheader-1.11.1-source.zip`.
2. Create a new, empty GitHub repository. Do not ask GitHub to add a README,
   `.gitignore`, or license because those choices can create an unnecessary
   first-commit conflict.
3. Open PowerShell in the extracted directory.
4. Run the following commands, replacing the repository URL:

```powershell
git init
git add .
git commit -m "MonoHeader 1.11.1 cross-browser source"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```

If Git asks for identity information before the commit, configure it once:

```powershell
git config --global user.name "Your Name"
git config --global user.email "your-address@example.com"
```

GitHub normally authenticates HTTPS pushes through a browser, Git Credential
Manager, or a personal access token. Do not paste credentials into project
files.

## Alternative: GitHub web upload

Create an empty repository, select **uploading an existing file**, extract the
source ZIP locally, and drag the extracted contents into the browser. Upload
the contents, including the `.github` directory, rather than the ZIP itself.

## After upload

The workflow in `.github/workflows/release-check.yml` runs the full Chrome and
Firefox release gate for pushes to `main` and for pull requests. Generated directories such as
`node_modules`, `dist`, `playwright-report`, and `test-results` are excluded by
`.gitignore`.

No software license has been granted by this repository package. Choose and add
a license only if Monolith Consulting AB intends to grant reuse rights.
