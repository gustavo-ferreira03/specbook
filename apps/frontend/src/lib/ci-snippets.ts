export const CI_PROVIDERS = [
    ["github", "GitHub Actions", ".github/workflows/specbook.yml"],
    ["gitlab", "GitLab CI", ".gitlab-ci.yml"],
    ["bitbucket", "Bitbucket Pipelines", "bitbucket-pipelines.yml"],
    ["circleci", "CircleCI", ".circleci/config.yml"],
    ["jenkins", "Jenkins", "Jenkinsfile"],
] as const;

export type CiProvider = typeof CI_PROVIDERS[number][0];

export function ciSnippet(provider: CiProvider, apiUrl: string, projectId: string, failOnFlaky: boolean, failOnKnownBugs: boolean, environment = "production"): string {
    const env = {
        SPECBOOK_API_URL: apiUrl,
        SPECBOOK_PROJECT_ID: projectId,
        SPECBOOK_ENVIRONMENT: environment,
        SPECBOOK_FAIL_ON_FLAKY: String(failOnFlaky),
        SPECBOOK_FAIL_ON_KNOWN_BUGS: String(failOnKnownBugs),
    };
    const yamlEnv = (indent: number) => Object.entries(env).map(([key, value]) => `${" ".repeat(indent)}${key}: ${JSON.stringify(value)}`).join("\n");
    const download = 'curl -fsS -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/client.mjs" -o specbook-ci.mjs';

    switch (provider) {
        case "github": return `name: Specbook
on: [workflow_dispatch, pull_request]
jobs:
  verify:
    if: github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]')
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    concurrency:
      group: specbook-${projectId}-\${{ github.event.pull_request.number || github.ref }}
      cancel-in-progress: false
    env:
${yamlEnv(6)}
      SPECBOOK_CI_TOKEN: \${{ secrets.SPECBOOK_CI_TOKEN }}
      SPECBOOK_COMMENT_PROVIDER: github
      GITHUB_TOKEN: \${{ github.token }}
      SPECBOOK_COMMIT_SHA: \${{ github.sha }}
      SPECBOOK_REF: \${{ github.ref_name }}
      SPECBOOK_BUILD_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 26
      - name: Verify application
        run: |
          ${download}
          node specbook-ci.mjs
      - name: Publish summary
        if: always()
        run: test ! -f specbook-summary.md || cat specbook-summary.md >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: specbook-results
          path: |
            specbook-junit.xml
            specbook-summary.md`;
        case "gitlab": return `specbook:
  image: node:26
  resource_group: specbook-$SPECBOOK_PROJECT_ID-$CI_MERGE_REQUEST_IID
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "web"'
  variables:
${yamlEnv(4)}
    SPECBOOK_COMMIT_SHA: "$CI_COMMIT_SHA"
    SPECBOOK_REF: "$CI_COMMIT_REF_NAME"
    SPECBOOK_BUILD_URL: "$CI_JOB_URL"
    SPECBOOK_COMMENT_PROVIDER: "gitlab"
  script:
    - |
      ${download}
      node specbook-ci.mjs
  artifacts:
    when: always
    reports:
      junit: specbook-junit.xml
    paths:
      - specbook-summary.md`;
        case "bitbucket": return `image: node:26
pipelines:
  default:
    - step:
        name: Verify with Specbook
        script:
${Object.entries(env).map(([key, value]) => `          - export ${key}='${value.replace(/'/g, "'\\''")}'`).join("\n")}
          - export SPECBOOK_COMMIT_SHA="$BITBUCKET_COMMIT"
          - export SPECBOOK_REF="$BITBUCKET_BRANCH"
          - export SPECBOOK_BUILD_URL="https://bitbucket.org/$BITBUCKET_REPO_FULL_NAME/pipelines/results/$BITBUCKET_BUILD_NUMBER"
          - mkdir -p test-results
          - export SPECBOOK_JUNIT_PATH="test-results/specbook.xml"
          - |
            ${download}
            node specbook-ci.mjs
        artifacts:
          - test-results/specbook.xml
          - specbook-summary.md`;
        case "circleci": return `version: 2.1
jobs:
  specbook:
    docker:
      - image: node:26
    environment:
${yamlEnv(6)}
      SPECBOOK_JUNIT_PATH: test-results/specbook.xml
    steps:
      - run:
          name: Verify with Specbook
          command: |
            export SPECBOOK_COMMIT_SHA="$CIRCLE_SHA1"
            export SPECBOOK_REF="$CIRCLE_BRANCH"
            export SPECBOOK_BUILD_URL="$CIRCLE_BUILD_URL"
            mkdir -p test-results
            ${download}
            node specbook-ci.mjs
      - store_test_results:
          path: test-results
      - store_artifacts:
          path: specbook-summary.md
workflows:
  verify:
    jobs:
      - specbook`;
        case "jenkins": return `pipeline {
  agent any // Node.js 26 and curl must be available.
  environment {
${Object.entries(env).map(([key, value]) => `    ${key} = '${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join("\n")}
    SPECBOOK_CI_TOKEN = credentials('specbook-ci-token')
  }
  stages {
    stage('Verify with Specbook') {
      steps {
        sh '''
          set +x
          export SPECBOOK_COMMIT_SHA="$GIT_COMMIT"
          export SPECBOOK_REF="$BRANCH_NAME"
          export SPECBOOK_BUILD_URL="$BUILD_URL"
          ${download}
          node specbook-ci.mjs
        '''
      }
    }
  }
  post {
    always {
      junit testResults: 'specbook-junit.xml', allowEmptyResults: true
      archiveArtifacts artifacts: 'specbook-summary.md', allowEmptyArchive: true
    }
  }
}`;
    }
}

export function mcpSnippet(apiUrl: string, projectId: string, token: string | null): string {
    return `claude mcp add --transport http specbook ${apiUrl.replace(/\/$/, "")}/mcp/projects/${projectId} --header "Authorization: Bearer ${token ?? "<token>"}"`;
}
