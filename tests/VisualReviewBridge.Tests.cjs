'use strict'

/**
 * Visual Review bridge + JS capability-plane tests (Phase V0/V1).
 *
 * Covers: /visual-review command detection, deterministic request
 * decomposition (screenshot paths vs question), the visualReviewer role in
 * the shared JS configuration layer (model-agnostic capability validation),
 * backward-compatible profile satisfiability, and the registry vision
 * capability contract. The transport itself is exercised with mocks in
 * tests/VisualReview.Tests.ps1.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const controller = require('../config/AihController.cjs')
const profiles = require('../config/Engineering-Profiles.cjs')

async function main() {
  // ── 1. /visual-review command detection is exact-prefix and deterministic ──
  assert.equal(controller.isVisualReviewCommand('/visual-review check the home screen'), true)
  assert.equal(controller.isVisualReviewCommand('/visual-review'), true)
  assert.equal(controller.isVisualReviewCommand('  /visual-review  review the shot'), true)
  assert.equal(controller.isVisualReviewCommand('/VISUAL-REVIEW check spacing'), true)
  assert.equal(controller.isVisualReviewCommand('please /visual-review this'), false, 'only a leading command is a visual review request')
  assert.equal(controller.isVisualReviewCommand('/visual-reviews extra'), false, 'the command boundary is word-delimited')
  assert.equal(controller.isVisualReviewCommand('check the home screen'), false)
  // the existing review command keeps its detection
  assert.equal(controller.isReviewCommand('/review check the boundary'), true)

  // ── 2. request decomposition: screenshots vs question ─────────────────────
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-visual-bridge-'))
  try {
    const existingShot = path.join(workspace, 'home-shot.png')
    fs.writeFileSync(existingShot, 'png-bytes')
    const relativeShot = path.join(workspace, 'relative-shot.jpg')
    fs.writeFileSync(relativeShot, 'jpg-bytes')

    // absolute existing path is extracted; the rest is the question
    const request1 = controller.visualReviewRequestOf(
      '/visual-review ' + existingShot + ' review the home screen spacing',
      workspace,
    )
    assert.deepEqual(request1.screenshots, [existingShot.toLowerCase() === existingShot ? existingShot : existingShot])
    assert.equal(request1.question, 'review the home screen spacing')
    assert.deepEqual(request1.references, [])
    assert.equal(request1.platform, 'unknown')

    // relative existing path resolves against the workspace
    const request2 = controller.visualReviewRequestOf('/visual-review relative-shot.jpg critique density', workspace)
    assert.deepEqual(request2.screenshots, [relativeShot])
    assert.equal(request2.question, 'critique density')

    // a path token that does NOT exist is kept as evidence so the controller
    // service fails closed with a structured invalid-image-path error — it is
    // never silently dropped and never sent to the model as part of the text.
    const request3 = controller.visualReviewRequestOf('/visual-review missing-shot.png review it', workspace)
    assert.deepEqual(request3.screenshots, [path.resolve(workspace, 'missing-shot.png')])
    assert.equal(request3.question, 'review it')

    // duplicate tokens (case-insensitive on the resolved path) are deduplicated
    const request4 = controller.visualReviewRequestOf('/visual-review ' + existingShot + ' ' + existingShot.toUpperCase() + ' twice', workspace)
    assert.equal(request4.screenshots.length, 1)

    // no path-shaped token -> empty screenshots (missing screenshot surface)
    const request5 = controller.visualReviewRequestOf('/visual-review just a question', workspace)
    assert.deepEqual(request5.screenshots, [])
    assert.equal(request5.question, 'just a question')

    // webp/gif token shapes are also recognized (PS validates type/budget later)
    const request6 = controller.visualReviewRequestOf('/visual-review shot.webp look', workspace)
    assert.deepEqual(request6.screenshots, [path.resolve(workspace, 'shot.webp')])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }

  // ── 3. JS capability plane: visualReviewer role requirements ───────────────
  const requirements = profiles.ROLE_REQUIREMENTS.visualReviewer
  assert.deepEqual(requirements, {
    writable: false,
    requiresTools: false,
    requiresSolLocal: false,
    requiresReasoning: true,
    requiresVision: true,
  })
  assert.equal(profiles.OPTIONAL_ROLES.length, 1)
  assert.equal(profiles.OPTIONAL_ROLES[0], 'visualReviewer')
  assert.equal(profiles.CORE_ROLES.length, 5)
  assert.equal(profiles.roleRequirementsOf('reviewer').requiresVision, false, 'the independent code reviewer is untouched')
  assert.equal(profiles.roleRequirementsOf('reviewer').requiresSolLocal, true)

  const registry = profiles.loadRegistry(profiles.installRootOf())
  const visionModel = registry.models.find((m) => m.id === 'deepseek-v4-flash-vision-exp')
  assert.ok(visionModel, 'deepseek-v4-flash-vision-exp is registered')
  assert.equal(visionModel.supportsVision, true)
  assert.equal(visionModel.readOnlyDefault, true)
  assert.equal(visionModel.supportsTools, false, 'the visual model is never a tool-carrying model')
  assert.equal(visionModel.provider, 'deepseek-vision-direct')

  // non-vision model rejected for the vision role; vision model accepted
  const flash = registry.models.find((m) => m.id === 'deepseek-v4-flash')
  assert.equal(profiles.modelCompatibleWithRole(visionModel, 'visualReviewer', 'high'), true)
  assert.equal(profiles.modelCompatibleWithRole(flash, 'visualReviewer', 'high'), false)
  const noDeclaration = { ...flash, id: 'no-declaration', supportsVision: undefined }
  delete noDeclaration.supportsVision
  assert.equal(profiles.modelCompatibleWithRole(noDeclaration, 'visualReviewer', 'high'), false, 'a missing vision declaration fails closed')

  // compatible model list for the role contains only vision-capable models
  const compatible = profiles.compatibleModelsForRole(registry, 'visualReviewer')
  assert.ok(compatible.includes('deepseek-v4-flash-vision-exp'))
  assert.ok(!compatible.includes('deepseek-v4-flash'))

  // ── 4. backward-compatible profile satisfiability ──────────────────────────
  const legacyProfile = {
    id: 'legacy',
    roles: {
      primaryEngineer: { model: 'deepseek-v4-flash', reasoning: 'high' },
      deepEngineer: { model: 'deepseek-v4-flash', reasoning: 'max' },
      reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
      solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
      fallback: { model: 'deepseek-v4-flash', reasoning: 'max' },
    },
  }
  assert.equal(profiles.bindingsSatisfiable(registry, legacyProfile), true, 'a profile WITHOUT visualReviewer stays satisfiable')

  const withVisual = {
    ...legacyProfile,
    roles: {
      ...legacyProfile.roles,
      visualReviewer: { model: 'deepseek-v4-flash-vision-exp', reasoning: 'high' },
    },
  }
  assert.equal(profiles.bindingsSatisfiable(registry, withVisual), true, 'a profile WITH visualReviewer stays satisfiable')
  const visualTarget = profiles.roleBindingTarget(registry, withVisual, 'visualReviewer')
  assert.ok(visualTarget, 'the visualReviewer binding resolves through the JS plane')
  assert.equal(visualTarget.modelId, 'deepseek-v4-flash-vision-exp')
  assert.equal(visualTarget.provider, 'deepseek-vision-direct')
  assert.equal(visualTarget.reasoning, 'high')

  const broken = { ...legacyProfile, roles: { ...legacyProfile.roles, reviewer: undefined } }
  assert.equal(profiles.bindingsSatisfiable(registry, broken), false, 'a missing CORE role still fails satisfiability')

  // both built-in profiles bind visualReviewer to the vision model / high
  const document = profiles.loadProfiles(profiles.installRootOf())
  for (const profile of document.profiles) {
    assert.equal(profile.roles.visualReviewer.model, 'deepseek-v4-flash-vision-exp', profile.id + ' binds visualReviewer to the vision model')
    assert.equal(profile.roles.visualReviewer.reasoning, 'high', profile.id + ' binds visualReviewer at high reasoning')
  }

  console.log('PASS: visual-review bridge + capability-plane behavior')
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error))
  process.exit(1)
})
