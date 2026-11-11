"""Pure composition/route checks. No SDK/VM/process/network entry is invoked."""
import ast,base64,copy,datetime,hashlib,importlib.util,itertools,json,pathlib,re,subprocess,tempfile,time,unittest
from types import SimpleNamespace as N
from unittest import mock
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('actual_ci_fullcase',HERE/'ci_fullcase.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REPO=HERE.parents[2]
FULL="((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-fullcase-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_full_case))"
INPUT="      aleo_full_case:\n        description: Run only reviewed dedicated Aleo Safe/Fast full cases (requires actual same-job prerequisites)\n        type: boolean\n        default: false\n"
# Exact current14-job inverse, including the reviewed fixed Radix startup-log upload.
# Further workflow-body changes still require explicit review and a new baseline.
BASE_SHA=('4cd870d5400e176162b90604d291e12a' '687ae7df934266f3ae7969e2c8173dac')
def evaluator():
 tree=ast.parse((REPO/'zig/tools/aleo_linux/kernel_only_test.py').read_text());ns={'re':re,'N':N}
 functions=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name in {'conditions','selected'}]
 exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-shared-route-evaluator','exec'),ns);return ns
def ordinary_native_http_workflow(text):
 # Exact inverse of the three reviewed pnpm temporary-HOME recipe changes.
 pnpm_home_after = "              archive=root/'archive.tgz';binary=root/'pnpm';version=root/'version.txt';passed=False\n              home=root/'home';home_identity=None\n              clean={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8','HOME':str(home)}\n"
 pnpm_home_before = "              archive=root/'archive.tgz';binary=root/'pnpm';version=root/'version.txt';passed=False\n              clean={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8','HOME':str(root)}\n"
 if text.count(pnpm_home_after) != 3: raise AssertionError('Exact three reviewed pnpm HOME workflow hunks required')
 text = text.replace(pnpm_home_after, pnpm_home_before)
 pnpm_home_after = "                  row=root.lstat();need(stat.S_ISDIR(row.st_mode)and(row.st_dev,row.st_ino)==identity,'Setup root identity changed')\n              def owned_home():\n                  owned();row=home.lstat();need(stat.S_ISDIR(row.st_mode)and(row.st_dev,row.st_ino)==home_identity,'Setup HOME identity changed')\n              def actual():\n"
 pnpm_home_before = "                  row=root.lstat();need(stat.S_ISDIR(row.st_mode)and(row.st_dev,row.st_ino)==identity,'Setup root identity changed')\n              def actual():\n"
 if text.count(pnpm_home_after) != 3: raise AssertionError('Exact three reviewed pnpm HOME workflow hunks required')
 text = text.replace(pnpm_home_after, pnpm_home_before)
 pnpm_home_after = "              try:\n                  home.mkdir(mode=0o700);home_identity=(home.stat().st_dev,home.stat().st_ino)\n                  curl=shutil.which('curl',path=clean['PATH']);need(curl is not None,'System curl required')\n"
 pnpm_home_before = "              try:\n                  curl=shutil.which('curl',path=clean['PATH']);need(curl is not None,'System curl required')\n"
 if text.count(pnpm_home_after) != 3: raise AssertionError('Exact three reviewed pnpm HOME workflow hunks required')
 text = text.replace(pnpm_home_after, pnpm_home_before)
 pnpm_home_after = "                  owned_home();shutil.rmtree(home);owned();archive.unlink();version.unlink()\n                  need({p.name for p in root.iterdir()}=={'pnpm'},'Unexpected setup output')\n"
 pnpm_home_before = "                  owned();archive.unlink();version.unlink()\n                  need({p.name for p in root.iterdir()}=={'pnpm'},'Unexpected setup output')\n"
 if text.count(pnpm_home_after) != 3: raise AssertionError('Exact three reviewed pnpm HOME workflow hunks required')
 text = text.replace(pnpm_home_after, pnpm_home_before)
 pnpm_home_after = '              finally:\n                  if not passed:\n                      owned()\n                      if home.exists()or home.is_symlink():owned_home()\n                      shutil.rmtree(root)\n'
 pnpm_home_before = '              finally:\n                  if not passed:owned();shutil.rmtree(root)\n'
 if text.count(pnpm_home_after) != 3: raise AssertionError('Exact three reviewed pnpm HOME workflow hunks required')
 text = text.replace(pnpm_home_after, pnpm_home_before)
 # Exact inverse of the reviewed default utility build and drained-handoff workflow route.
 handoff_after = '        run: \'"$ZIG" fmt --check zig/build.zig zig/src zig/bench/main.zig\'\n      - name: Test\n        run: python3 zig/tools/zig.py build test -j"${BUILD_JOBS}" -Doptimize=${{ matrix.mode }} --summary all\n      - name: Build complete default utility targets\n        timeout-minutes: 10\n        run: python3 zig/tools/zig.py build -Dtarget=native -Dcpu=baseline -j"${BUILD_JOBS}" -Doptimize=${{ matrix.mode }} --summary all\n\n  evm:\n    if: ${{ !((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-paired-linux]\')) || (github.event_name == \'workflow_dispatch\' && inputs.paired_linux)) && (!((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-aleo-fullcase-only]\')) || (github.event_name == \'workflow_dispatch\' && inputs.aleo_full_case)) && (!((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-aleo-docker-only]\')) || (github.event_name == \'workflow_dispatch\' && inputs.aleo_native_docker_prerequisite)) && (!((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-aleo-sdk-only]\')) || (github.event_name == \'workflow_dispatch\' && inputs.aleo_linux_sdk_prerequisite)) && (!((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-aleo-kernel-only]\')) || (github.event_name == \'workflow_dispatch\' && inputs.aleo_linux_prerequisite)) && (!(github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-native-case]\')) && (!(github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-svm-prerequisites-only]\')) && (github.event_name != \'workflow_dispatch\' || !inputs.svm_prerequisites))))))) }}\n'
 handoff_before = '        run: \'"$ZIG" fmt --check zig/build.zig zig/src zig/bench/main.zig\'\n      - name: Test\n        run: python3 zig/tools/zig.py build test -j"${BUILD_JOBS}" -Doptimize=${{ matrix.mode }} --summary all\n\n  evm:\n    if: ${{ !((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-paired-linux]\')) || (github.event_name == \'workflow_dispatch\' && inputs.paired_linux)) && (!((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-aleo-fullcase-only]\')) || (github.event_name == \'workflow_dispatch\' && inputs.aleo_full_case)) && (!((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-aleo-docker-only]\')) || (github.event_name == \'workflow_dispatch\' && inputs.aleo_native_docker_prerequisite)) && (!((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-aleo-sdk-only]\')) || (github.event_name == \'workflow_dispatch\' && inputs.aleo_linux_sdk_prerequisite)) && (!((github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-aleo-kernel-only]\')) || (github.event_name == \'workflow_dispatch\' && inputs.aleo_linux_prerequisite)) && (!(github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-native-case]\')) && (!(github.event_name == \'push\' && github.ref == \'refs/heads/feat/zig-agent-rewrite\' && contains(github.event.head_commit.message, \'[zig-svm-prerequisites-only]\')) && (github.event_name != \'workflow_dispatch\' || !inputs.svm_prerequisites))))))) }}\n'
 if text.count(handoff_after) != 1: raise AssertionError('Exact once-only reviewed utility/handoff workflow hunk required')
 text = text.replace(handoff_after, handoff_before, 1)
 handoff_after = '      actions: read\n    outputs:\n      functional_enabled: ${{ steps.authority.outputs.functional_enabled }}\n      handoff_enabled: ${{ steps.authority.outputs.handoff_enabled }}\n      proof_phase: ${{ steps.authority.outputs.proof_phase }}\n      runtime_enabled: ${{ steps.authority.outputs.runtime_enabled }}\n      request_sha256: ${{ steps.authority.outputs.request_sha256 }}\n      manifest_sha256: ${{ steps.manifest.outputs.sha256 }}\n'
 handoff_before = '      actions: read\n    outputs:\n      functional_enabled: ${{ steps.authority.outputs.functional_enabled }}\n      runtime_enabled: ${{ steps.authority.outputs.runtime_enabled }}\n      request_sha256: ${{ steps.authority.outputs.request_sha256 }}\n      manifest_sha256: ${{ steps.manifest.outputs.sha256 }}\n'
 if text.count(handoff_after) != 1: raise AssertionError('Exact once-only reviewed utility/handoff workflow hunk required')
 text = text.replace(handoff_after, handoff_before, 1)
 handoff_after = "          if-no-files-found: error\n          retention-days: 14\n  paired-linux-functional:\n    if: ${{ ((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux)) && !((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-fullcase-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_full_case)) && !((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-docker-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_native_docker_prerequisite)) && !((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-sdk-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_linux_sdk_prerequisite)) && !((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-kernel-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_linux_prerequisite)) && (needs.paired-linux-inputs.outputs.functional_enabled == 'true' || needs.paired-linux-inputs.outputs.handoff_enabled == 'true') }}\n    name: ${{ matrix.phase == 'handoff' && 'paired-linux-handoff' || 'paired-linux-functional' }} (${{ matrix.index }})\n    needs: paired-linux-inputs\n    runs-on: depot-ubuntu-24.04-8\n    timeout-minutes: 180\n"
 handoff_before = "          if-no-files-found: error\n          retention-days: 14\n  paired-linux-functional:\n    if: ${{ ((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux)) && !((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-fullcase-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_full_case)) && !((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-docker-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_native_docker_prerequisite)) && !((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-sdk-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_linux_sdk_prerequisite)) && !((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-kernel-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_linux_prerequisite)) && needs.paired-linux-inputs.outputs.functional_enabled == 'true' }}\n    needs: paired-linux-inputs\n    runs-on: depot-ubuntu-24.04-8\n    timeout-minutes: 180\n"
 if text.count(handoff_after) != 1: raise AssertionError('Exact once-only reviewed utility/handoff workflow hunk required')
 text = text.replace(handoff_after, handoff_before, 1)
 handoff_after = "      fail-fast: false\n      max-parallel: 2\n      matrix:\n        phase: ['${{ needs.paired-linux-inputs.outputs.proof_phase }}']\n        index: [0, 1, 2, 3, 4, 5]\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
 handoff_before = '      fail-fast: false\n      max-parallel: 2\n      matrix:\n        index: [0, 1, 2, 3, 4, 5]\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n'
 if text.count(handoff_after) != 1: raise AssertionError('Exact once-only reviewed utility/handoff workflow hunk required')
 text = text.replace(handoff_after, handoff_before, 1)
 handoff_after = '          GH_TOKEN: ${{ github.token }}\n        run: |\n          set -euo pipefail\n          if [ \'${{ matrix.phase }}\' = handoff ]; then\n            python3 -I -B zig/bench/paired_linux_stage.py \\\n              --prepared-handoff \\\n              --request "$GITHUB_WORKSPACE/zig/bench/paired_linux_request.json" \\\n              --request-sha256 \'${{ needs.paired-linux-inputs.outputs.request_sha256 }}\' \\\n              --repo "$GITHUB_WORKSPACE" --output "$RUNNER_TEMP/paired-linux-stage"\n          else\n          python3 -I -B zig/bench/paired_linux_stage.py \\\n            --request "$GITHUB_WORKSPACE/zig/bench/paired_linux_request.json" \\\n            --request-sha256 \'${{ needs.paired-linux-inputs.outputs.request_sha256 }}\' \\\n'
 handoff_before = '          GH_TOKEN: ${{ github.token }}\n        run: |\n          set -euo pipefail\n          python3 -I -B zig/bench/paired_linux_stage.py \\\n            --request "$GITHUB_WORKSPACE/zig/bench/paired_linux_request.json" \\\n            --request-sha256 \'${{ needs.paired-linux-inputs.outputs.request_sha256 }}\' \\\n'
 if text.count(handoff_after) != 1: raise AssertionError('Exact once-only reviewed utility/handoff workflow hunk required')
 text = text.replace(handoff_after, handoff_before, 1)
 handoff_after = '            --input-run-id "$GITHUB_RUN_ID" --input-run-attempt "$GITHUB_RUN_ATTEMPT" \\\n            --input-source-commit "$GITHUB_SHA" \\\n            --manifest-sha256 \'${{ needs.paired-linux-inputs.outputs.manifest_sha256 }}\'\n          fi\n      - name: Run one separately authorized exact-binary proof phase\n        timeout-minutes: 122\n        run: |\n          set -euo pipefail\n          PROOF_OUTPUT="$RUNNER_TEMP/paired-linux-proof-${{ matrix.index }}"\n          if [ \'${{ matrix.phase }}\' = handoff ]; then PROOF_OUTPUT="$RUNNER_TEMP/paired-linux-handoff-${{ matrix.index }}"; fi\n          python3 -I -B zig/bench/paired_linux_owner.py --phase \'${{ matrix.phase }}\' \\\n            --request "$GITHUB_WORKSPACE/zig/bench/paired_linux_request.json" \\\n            --request-sha256 \'${{ needs.paired-linux-inputs.outputs.request_sha256 }}\' \\\n            --repo "$GITHUB_WORKSPACE" --inputs "$RUNNER_TEMP/paired-linux-stage/published" \\\n            --index \'${{ matrix.index }}\' --output "$PROOF_OUTPUT"\n      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\n        if: always()\n        with:\n          name: ${{ matrix.phase == \'handoff\' && \'paired-linux-handoff\' || \'paired-linux-proof\' }}-${{ matrix.index }}-${{ github.run_id }}-${{ github.run_attempt }}\n          if-no-files-found: warn\n          retention-days: 14\n          path: |\n            ${{ runner.temp }}/paired-linux-handoff-${{ matrix.index }}/owner-result.json\n            ${{ runner.temp }}/paired-linux-handoff-${{ matrix.index }}/handoff-result.json\n            ${{ runner.temp }}/paired-linux-handoff-${{ matrix.index }}/handoff-proof.json\n            ${{ runner.temp }}/paired-linux-handoff-${{ matrix.index }}/postgres/\n            ${{ runner.temp }}/paired-linux-handoff-${{ matrix.index }}/raw/\n            ${{ runner.temp }}/paired-linux-handoff-${{ matrix.index }}/resources.jsonl\n            ${{ runner.temp }}/paired-linux-handoff-${{ matrix.index }}/worker.log\n            ${{ runner.temp }}/paired-linux-stage/consumer-result.json\n            ${{ runner.temp }}/paired-linux-stage/reuse-result.json\n            ${{ runner.temp }}/paired-linux-stage/accepted-six.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/owner-result.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/functional-result.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/actual-agent-launches.json\n'
 handoff_before = '            --input-run-id "$GITHUB_RUN_ID" --input-run-attempt "$GITHUB_RUN_ATTEMPT" \\\n            --input-source-commit "$GITHUB_SHA" \\\n            --manifest-sha256 \'${{ needs.paired-linux-inputs.outputs.manifest_sha256 }}\'\n      - name: Run one original exact-binary600+30 functional proof\n        timeout-minutes: 122\n        run: |\n          set -euo pipefail\n          python3 -I -B zig/bench/paired_linux_owner.py --phase functional \\\n            --request "$GITHUB_WORKSPACE/zig/bench/paired_linux_request.json" \\\n            --request-sha256 \'${{ needs.paired-linux-inputs.outputs.request_sha256 }}\' \\\n            --repo "$GITHUB_WORKSPACE" --inputs "$RUNNER_TEMP/paired-linux-stage/published" \\\n            --index \'${{ matrix.index }}\' --output "$RUNNER_TEMP/paired-linux-proof-${{ matrix.index }}"\n      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\n        if: always()\n        with:\n          name: paired-linux-proof-${{ matrix.index }}-${{ github.run_id }}-${{ github.run_attempt }}\n          if-no-files-found: warn\n          retention-days: 14\n          path: |\n            ${{ runner.temp }}/paired-linux-stage/consumer-result.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/owner-result.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/functional-result.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/actual-agent-launches.json\n'
 if text.count(handoff_after) != 1: raise AssertionError('Exact once-only reviewed utility/handoff workflow hunk required')
 text = text.replace(handoff_after, handoff_before, 1)
 # Exact inverse of the once-only hard-latch observer control command.
 latch = '          python3 -I -B -W error zig/integration/multivm_observer_latch_test.py -v\n'
 if text.count(latch) != 1: raise AssertionError('Exact once-only observer hard-latch control required')
 text = text.replace(latch, '', 1)
 # Exact enabled Aleo runner setup inverse; all profile/authority bytes are reviewed.
 aleo_start = '      - name: Load distro bwrap user namespace policy for Aleo\n'
 aleo_next = '      - name: Exact transport, both interops, fresh SDK/Docker/kernel and dedicated case\n'
 if text.count(aleo_start) != 1 or text.count(aleo_next) != 1: raise AssertionError('Exact once-only Aleo profile setup required')
 begin = text.index(aleo_start); end = text.index(aleo_next, begin)
 if hashlib.sha256(text[begin:end].encode()).hexdigest() != ('6d30386b0d596e3346452c733038dfb4e' '898e8bf541ba844d1fe7c8562b7d81c'): raise AssertionError('Exact reviewed Aleo profile setup bytes required')
 text = text[:begin] + text[end:]
 aleo_packages = '          sudo apt-get install -y --no-install-recommends apparmor=4.0.1really4.0.1-0ubuntu0.24.04.9 apparmor-profiles=4.0.1really4.0.1-0ubuntu0.24.04.9\n'
 if text.count(aleo_packages) != 1: raise AssertionError('Exact pinned Aleo AppArmor package install required')
 text = text.replace(aleo_packages, '', 1)
 # Exact SVM-only distro profile setup inverse; no other workflow changes normalize.
 svm_start = '      - name: Load distro bwrap user namespace policy\n'
 svm_next = '      - name: Check prerequisite owner controls\n'
 if text.count(svm_start) != 1 or text.count(svm_next) != 1: raise AssertionError('Exact once-only SVM profile setup required')
 begin = text.index(svm_start); end = text.index(svm_next, begin)
 if hashlib.sha256(text[begin:end].encode()).hexdigest() != 'f656916a8890e0edcc751b628182acdb' '3ff16d43d165d57d6ca1c9f8d3e67c91': raise AssertionError('Exact reviewed SVM profile setup bytes required')
 text = text[:begin] + text[end:]
 svm_after = '            pkg-config protobuf-compiler bubblewrap git ca-certificates python3 \\\n            apparmor=4.0.1really4.0.1-0ubuntu0.24.04.9 apparmor-profiles=4.0.1really4.0.1-0ubuntu0.24.04.9\n'
 svm_before = '            pkg-config protobuf-compiler bubblewrap git ca-certificates python3\n'
 if text.count(svm_after) != 1: raise AssertionError('Exact pinned SVM AppArmor package install required')
 text = text.replace(svm_after, svm_before, 1)
 # Exact inverse of the portable native-linux compiler commands; cold/paired remain separately reviewed.
 portable_after = '        run: python3 zig/src/net/native-url/locked.py --toolchain 1.98.0 --cpu-recipe-output "$RUNNER_TEMP/native-url-cpu.json"\n'
 portable_before = '        run: python3 zig/src/net/native-url/locked.py --toolchain 1.98.0\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '          python3 zig/tools/native_deps.py --cpu-profile x86_64_v3_pclmul_native_abi --git-sha "$GITHUB_SHA" --offline --jobs "${BUILD_JOBS}" \\\n'
 portable_before = '          python3 zig/tools/native_deps.py --offline --jobs "${BUILD_JOBS}" \\\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '            python3 zig/tools/zig.py build -Dtarget=native -Dcpu=x86_64_v3+pclmul -j"${BUILD_JOBS}" native-db-test relayer validator \\\n'
 portable_before = '            python3 zig/tools/zig.py build -j"${BUILD_JOBS}" native-db-test relayer validator \\\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '          python3 zig/tools/zig.py test -target native -mcpu=x86_64_v3+pclmul src/durable_directory_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc -lstdc++ "${native_libs[@]}"\n'
 portable_before = '          python3 zig/tools/zig.py test src/durable_directory_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc -lstdc++ "${native_libs[@]}"\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '        run: python3 zig/tools/zig.py build -Dtarget=native -Dcpu=x86_64_v3+pclmul -j"${BUILD_JOBS}" scraper -Doptimize=ReleaseSafe "-Dgit-sha=$GITHUB_SHA" "-Dlibpq-library=$LIBPQ"\n'
 portable_before = '        run: python3 zig/tools/zig.py build -j"${BUILD_JOBS}" scraper -Doptimize=ReleaseSafe "-Dgit-sha=$GITHUB_SHA" "-Dlibpq-library=$LIBPQ"\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '          python3 zig/tools/zig.py test -target native -mcpu=x86_64_v3+pclmul src/socket_owner_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc\n          python3 zig/tools/zig.py test -target native -mcpu=x86_64_v3+pclmul src/websocket_delegated_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc\n'
 portable_before = '          python3 zig/tools/zig.py test src/socket_owner_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc\n          python3 zig/tools/zig.py test src/websocket_delegated_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '          python3 zig/tools/zig.py build-exe -target native -mcpu=x86_64_v3+pclmul src/relayer_bridge_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc -lstdc++ "${native_libs[@]}" -femit-bin="$GITHUB_WORKSPACE/zig/bench/results/native-linux/relayer_bridge_tests"\n'
 portable_before = '          python3 zig/tools/zig.py build-exe src/relayer_bridge_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc -lstdc++ "${native_libs[@]}" -femit-bin="$GITHUB_WORKSPACE/zig/bench/results/native-linux/relayer_bridge_tests"\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '          python3 zig/src/ops/tools/locked.py --toolchain 1.98.0 --cpu-recipe-output "$RUNNER_TEMP/native-regex-cpu.json"\n'
 portable_before = '          python3 zig/src/ops/tools/locked.py --toolchain 1.98.0\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '          python3 zig/tools/zig.py test -target native -mcpu=x86_64_v3+pclmul src/ops_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc\n'
 portable_before = '          python3 zig/tools/zig.py test src/ops_tests.zig -O ReleaseSafe -j"${BUILD_JOBS}" -lc\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 portable_after = '            python3 zig/integration/postgres.py --cpu-profile x86_64_v3_pclmul_native_abi --compiler "$ZIG" \\\n'
 portable_before = '            python3 zig/integration/postgres.py --compiler "$ZIG" \\\n'
 if text.count(portable_after) != 1: raise AssertionError('Exact once-only portable native-linux compiler command required')
 text = text.replace(portable_after, portable_before, 1)
 # Exact inverse of the NativeLinux native-db libpq object argument.
 pq_after = '"-Dnative-db-libs=$LIBS" "-Dlibpq-library=$LIBPQ" --summary all'
 pq_before = '"-Dnative-db-libs=$LIBS" --summary all'
 if text.count(pq_after) != 1: raise AssertionError('Exact once-only native DB libpq argument required')
 text = text.replace(pq_after, pq_before, 1)
 # Exact inverse of once-only EVM and Stark adapter controls before peer controls.
 evm = '          python3 -B -W error zig/integration/multivm_evm_admission_test.py -v\n'
 stark = '          python3 -I -B -W error zig/integration/multivm_starknet_test.py -v\n'
 peers = '          python3 -I -B -W error zig/integration/multivm_starknet_peers_test.py -v\n'
 if text.count(evm) != 1 or text.count(stark) != 1 or text.count(evm + stark + peers) != 1: raise AssertionError('Exact once-only EVM/Stark adapter block before peer controls required')
 text = text.replace(evm + stark, '', 1)
 # Exact inverse of native PostgreSQL16 package admission in Aleo only.
 apt_after = '          sudo apt-get install -y --no-install-recommends bubblewrap python3 postgresql-client-16 libcurl4t64 libssl3t64\n'
 apt_before = '          sudo apt-get install -y --no-install-recommends bubblewrap python3 postgresql-client libcurl4t64 libssl3t64\n'
 if text.count(apt_after) != 1: raise AssertionError('Exact Aleo native PostgreSQL16 install required')
 text = text.replace(apt_after, apt_before, 1)
 # Exact inverse of the once-only Source Tron admission command before clock controls.
 admission = '          python3 -B -W error zig/integration/multivm_tron_admission_test.py -v\n'
 clock = '          python3 -I -B -W error zig/integration/multivm_tron_clock_test.py -v\n'
 if text.count(admission) != 1 or text.count(admission + clock) != 1: raise AssertionError('Exact once-only Tron admission before clock required')
 text = text.replace(admission, '', 1)
 # Exact inverse of the independently reviewed EVM consumer-control additions.
 evm_after = '      - name: Run three independent EVM dependency controls after owned case cleanup\n        id: evm_controls\n        if: ${{ success() && steps.request.outputs.enabled == \'true\' && steps.request.outputs.scenario == \'evm\' }}\n        timeout-minutes: 15\n        env:\n          GH_TOKEN: ${{ github.token }}\n        shell: bash\n        run: |\n          set -euo pipefail\n          sudo apt-get update\n          sudo apt-get install -y --no-install-recommends build-essential\n          exec env -i PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C.UTF-8 GITHUB_ACTIONS=true GH_TOKEN="$GH_TOKEN" \\\n            python3 -I -B zig/bench/native_case_tools.py evm-controls --execute \\\n            --repo "$GITHUB_WORKSPACE" --execution-source-commit "$GITHUB_SHA" \\\n            --case-root "/tmp/znc-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \\\n            --composition-result "$RUNNER_TEMP/native-case-composition-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT/result.json" \\\n            --tools "$RUNNER_TEMP/native-case-selection/preinstalled-tools.json" \\\n            --gh "$(readlink -f "$(command -v gh)")" \\\n            --output "$RUNNER_TEMP/evm-consumer-controls-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"\n'
 evm_before = ''
 if text.count(evm_after) != 1: raise AssertionError('Exact once-only EVM post-case component step required')
 text = text.replace(evm_after, evm_before, 1)
 evm_after = "      - name: Retain only the closed independent EVM control result\n        if: ${{ always() && steps.request.outputs.enabled == 'true' && steps.request.outputs.scenario == 'evm' }}\n        uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\n        with:\n          name: native-evm-consumer-controls-${{ github.run_id }}-${{ github.run_attempt }}\n          if-no-files-found: warn\n          retention-days: 14\n          path: ${{ runner.temp }}/evm-consumer-controls-${{ github.run_id }}-${{ github.run_attempt }}/public/result.json\n"
 evm_before = ''
 if text.count(evm_after) != 1: raise AssertionError('Exact once-only EVM closed component artifact required')
 text = text.replace(evm_after, evm_before, 1)
 evm_after = "with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:output.write('enabled='+str(enabled).lower()+'\\n');output.write('sha256='+module.pin(path)['sha256']+'\\n');output.write('scenario='+(request['scenario'] if enabled else '')+'\\n')"
 evm_before = "with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:output.write('enabled='+str(enabled).lower()+'\\n');output.write('sha256='+module.pin(path)['sha256']+'\\n')"
 if text.count(evm_after) != 1: raise AssertionError('Exact once-only EVM validated scenario metadata required')
 text = text.replace(evm_after, evm_before, 1)
 # Exact inverse of the isolated diagnostic's three native-http-only hunks.
 only = "(github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-native-http-diagnostic-only]') && contains(github.event.head_commit.message, '[zig-paired-linux]') && !contains(github.event.head_commit.message, '[zig-native-case]') && !contains(github.event.head_commit.message, '[zig-svm-prerequisites-only]'))"
 prefix = '    if: ${{ ' + only + ' || ('
 rows = text.splitlines(True)
 matches = [i for i, line in enumerate(rows) if line.startswith(prefix)]
 if len(matches) != 1: raise AssertionError('Exact native HTTP diagnostic-only branch required')
 index = matches[0];line = rows[index]
 if not line.endswith(') }}\n'): raise AssertionError('Exact diagnostic-only branch suffix required')
 rows[index] = '    if: ${{ ' + line[len(prefix):-len(') }}\n')] + ' }}\n'
 text = ''.join(rows)
 guard = '        if: ${{ !' + only + ' }}\n'
 if text.count(guard) != 1: raise AssertionError('Exact diagnostic-only suite guard required')
 text = text.replace(guard, '', 1)
 before = "contains(github.event.head_commit.message, '[zig-native-http-diagnostic]')"
 after = "(contains(github.event.head_commit.message, '[zig-native-http-diagnostic]') || (github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-native-http-diagnostic-only]') && contains(github.event.head_commit.message, '[zig-paired-linux]') && !contains(github.event.head_commit.message, '[zig-native-case]') && !contains(github.event.head_commit.message, '[zig-svm-prerequisites-only]')))"
 if text.count(after) != 1: raise AssertionError('Exact diagnostic marker extension required')
 text = text.replace(after, before, 1)
 full_timeout = "        timeout-minutes: ${{ ((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-native-http-diagnostic-only]') && contains(github.event.head_commit.message, '[zig-paired-linux]') && !contains(github.event.head_commit.message, '[zig-native-case]') && !contains(github.event.head_commit.message, '[zig-svm-prerequisites-only]')) && contains(github.event.head_commit.message, '[zig-native-http-full-suite]')) && 23 || 7 }}\n"
 if text.count(full_timeout) != 1: raise AssertionError('Exact full-suite timeout branch required')
 return text.replace(full_timeout, '        timeout-minutes: 7\n', 1)

class Routes(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.text=(REPO/'.github/workflows/zig-agents.yml').read_text();cls.ns=evaluator();cls.rows=cls.ns['conditions'](cls.text)
  cls.legacy_text=ordinary_native_http_workflow(cls.text).split('  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0].rstrip()+'\n';cls.legacy_text=cls.legacy_text.replace('      paired_linux:\n        description: Run reviewed Linux paired input/proof preparation; timings require separate final authority\n        type: boolean\n        default: false\n','',1)
  prefix='    if: ${{ !'+"((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux))"+' && ('
  cls.legacy_text=''.join(('    if: ${{ '+line[len(prefix):-5]+' }}\n')if line.startswith(prefix)else line for line in cls.legacy_text.splitlines(True));cls.legacy_rows=cls.ns['conditions'](cls.legacy_text)
 def selected(self,**kw):return self.ns['selected'](self.rows,**kw)
 def test_exact15jobs_and_both_mode_serial_hardbounds(self):
  self.assertEqual(len(self.rows),18);self.assertEqual(len(self.legacy_rows),15);job=self.legacy_text.split('\n  aleo-full-case:',1)[1]
  for item in ['mode: [ReleaseSafe, ReleaseFast]','max-parallel: 1','timeout-minutes: 330','runs-on: depot-ubuntu-24.04-16','actions: read','persist-credentials: false']:self.assertIn(item,job)
 def test_all14_old_bodies_have_exact_inverse(self):
  old=self.legacy_text.split('\n  aleo-full-case:',1)[0];old=old.replace(INPUT,'',1)
  lines=[];count=0
  for line in old.splitlines(True):
   prefix='    if: ${{ !'+FULL+' && ('
   if line.startswith(prefix):
    self.assertTrue(line.endswith(') }}\n'));line='    if: ${{ '+line[len(prefix):-5]+' }}\n';count+=1
   lines.append(line)
  self.assertEqual(count,14);self.assertEqual(hashlib.sha256(''.join(lines).encode()).hexdigest(),BASE_SHA)
 def test_full_request_excludes_all14_with_old_svm_cold_case_markers(self):
  for extra in ['', ' [zig-native-case]', ' [zig-svm-prerequisites-only]',' [zig-native-case] [zig-svm-prerequisites-only]']:
   self.assertEqual(self.selected(message='[zig-aleo-fullcase-only]'+extra),{'aleo-full-case'})
  for svm,cold in itertools.product([False,True],repeat=2):self.assertEqual(self.selected(event='workflow_dispatch',full=True,svm=svm,cold=cold),{'aleo-full-case'})
 def test_conflicting_dedicated_authorities_all_skip(self):
  for sdk,kernel,docker in itertools.product([False,True],repeat=3):
   if sdk or kernel or docker:self.assertEqual(self.selected(event='workflow_dispatch',full=True,sdk=sdk,aleo=kernel,docker=docker),set())
  for marker in ['sdk','kernel','docker']:self.assertEqual(self.selected(message='[zig-aleo-fullcase-only] [zig-aleo-'+marker+'-only]'),set())
 def test_ordinary288_combinations_identical_to_original14(self):
  old={k:v[len('${{ !'+FULL+' && ('):-4]+' }}'for k,v in self.legacy_rows.items()if k!='aleo-full-case'}
  # v tail is ') }}'; reconstruct exact old expression, never drop arbitrary fields.
  old={k:'${{ '+v[len('${{ !'+FULL+' && ('):-4]+' }}'for k,v in self.legacy_rows.items()if k!='aleo-full-case'}
  count=0
  for event,ref,message,flags in itertools.product(['push','pull_request','workflow_dispatch'],['refs/heads/main','refs/heads/feat/zig-agent-rewrite'],['ordinary','[zig-native-case]','[zig-svm-prerequisites-only]'],itertools.product([False,True],repeat=4)):
   svm,cold,sdk,aleo=flags;kw=dict(event=event,ref=ref,message=message,svm=svm,cold=cold,sdk=sdk,aleo=aleo)
   self.assertEqual(self.selected(**kw),self.ns['selected'](old,**kw));count+=1
  self.assertEqual(count,288)
 def test_unrelated_branch_and_PR_full_marker_do_not_activate(self):
  for event,ref in [('pull_request','refs/heads/feat/zig-agent-rewrite'),('push','refs/heads/main')]:self.assertNotIn('aleo-full-case',self.selected(event=event,ref=ref,message='[zig-aleo-fullcase-only]'))
 def test_all_python_invocations_isolated_and_no_raw_fallback(self):
  job=self.legacy_text.split('\n  aleo-full-case:',1)[1]
  calls=[line for line in job.splitlines()if 'python3 'in line and 'apt-get'not in line]
  self.assertEqual(len(calls),4);self.assertTrue(all('python3 -I -B'in line for line in calls))
  self.assertNotIn('run-locally',job);self.assertNotIn('**',job);self.assertNotIn('workflow_dispatch:',job)
 def test_policy_cli_binds_absolute_checkout_path_for_select_and_execute(self):
  # Both actual CLI sites call pin(), which deliberately rejects relative paths.
  job=self.legacy_text.split('\n  aleo-full-case:',1)[1]
  assigned=re.findall(r'^\s+POLICY=(.+)$',job,re.MULTILINE)
  self.assertEqual(assigned,['"$GITHUB_WORKSPACE/zig/tools/aleo_linux_case/ci_policy.PENDING.json"']*2)
  self.assertIn('--select',job);self.assertIn('--execute',job)
class Policy(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve();self.value=json.loads((HERE/'ci_policy.PENDING.json').read_text())
  # Negative fixtures stay inert even when the real checked-in case policy is activated.
  self.value.update(root_approved=False,selected_mode=None,runtime_source_commit=None,requests={mode:None for mode in m.MODES},qualified_cohort=None,qualified_docker=None,required_source=None)
 def descriptor(self,value):
  p=self.root/'policy.json';p.write_text(json.dumps(value));return m.pin(p)
 def test_false_policy_is_inert_for_both_modes_before_any_effect(self):
  row=self.descriptor(self.value)
  for mode in m.MODES:
   with mock.patch.object(m,'job_observation',side_effect=AssertionError('API reached')),mock.patch.object(m.subprocess,'Popen',side_effect=AssertionError('child reached')):
    out=m.execute(row['path'],row['sha256'],mode,{'GITHUB_WORKSPACE':str(self.root)})
    self.assertEqual(out,{'enabled':False,'native_case_acceptance':False});self.assertEqual(sorted(p.name for p in self.root.iterdir()),['policy.json'])
 def test_lifecycle_and_authority_types_cannot_be_changed(self):
  for key,value in [('confirm_seconds',599),('restart_seconds',29),('proof_seconds',10799),('service_seconds',11161),('job_minutes',331),('root_approved',1)]:
   bad={**self.value,key:value};row=self.descriptor(bad)
   with self.subTest(key=key),self.assertRaises(ValueError):m.policy(row['path'],row['sha256'],'ReleaseSafe',self.root)
 def test_approved_missing_qualification_never_becomes_execution(self):
  self.value.update(root_approved=True,selected_mode='ReleaseSafe',runtime_source_commit='a'*40);row=self.descriptor(self.value)
  with self.assertRaises(ValueError):m.policy(row['path'],row['sha256'],'ReleaseSafe',self.root)
 def test_duplicate_json_keys_reject(self):
  with self.assertRaisesRegex(ValueError,'duplicate'):m.decode('{"root_approved":false,"root_approved":true}')
 def test_fixed_child_environment_excludes_auth_proxy_fault_aliases(self):
  env={k:'fixture'for k in ['PATH','GITHUB_WORKSPACE','RUNNER_TEMP','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_REPOSITORY']};env.update(GH_TOKEN='private-marker',HTTPS_PROXY='private-marker',NODE_OPTIONS='private-marker',CONFIG_FILES='private-marker')
  out=m.fixed_environment(env);self.assertNotIn('private-marker',json.dumps(out));self.assertNotIn('HOME',out)
class NativePsql16(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='aleo-psql-pure-');self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name)
  # Actual existing ELF admission functions; no native executable is invoked.
  source=REPO/'zig/bench/native_case_tools.py';tree=ast.parse(source.read_bytes());scope={'Path':pathlib.Path,'struct':__import__('struct')}
  nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name in {'require','regular','validate_elf'}]
  exec(compile(ast.Module(nodes,type_ignores=[]),str(source),'exec'),scope);self.tools=N(validate_elf=scope['validate_elf'])
 def elf(self,machine=62):
  import struct
  wire=bytearray(1024);wire[:8]=b'\x7fELF\x02\x01\x01\x00';struct.pack_into('<HHIQQ',wire,16,2,machine,1,0x400100,64);struct.pack_into('<HHH',wire,52,64,56,1);struct.pack_into('<IIQQQQQQ',wire,64,1,5,0,0x400000,0,1024,1024,4096);return bytes(wire)
 def test_actual_binding_uses_native16_ELF_not_resolved_debian_wrapper(self):
  native=self.root/'usr/lib/postgresql/16/bin/psql';native.parent.mkdir(parents=True);native.write_bytes(self.elf());native.chmod(0o755)
  wrapper=self.root/'usr/share/postgresql-common/pg_wrapper';wrapper.parent.mkdir(parents=True);wrapper.write_text('#!/usr/bin/perl\n# synthetic never executed\n');bare=self.root/'usr/bin/psql';bare.parent.mkdir(parents=True);bare.symlink_to(wrapper)
  def path(value):return native if str(value)=='/usr/lib/postgresql/16/bin/psql'else pathlib.Path(value)
  with mock.patch.object(m,'Path',side_effect=path),mock.patch.object(m,'module',return_value=self.tools)as loader:
   selected=m.native_psql16(REPO)
  self.assertEqual(selected,m.pin(native));self.assertNotEqual(selected,m.pin(bare.resolve()));loader.assert_called_once_with(REPO,'actual_psql_ELF_admission','zig/bench/native_case_tools.py')
  tree=ast.parse(pathlib.Path(m.__file__).read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='execute');binding=next(n for n in ast.walk(fn)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='binding'for t in n.targets));tools=next(v for k,v in zip(binding.value.keys,binding.value.values)if isinstance(k,ast.Constant)and k.value=='tools');psql=next(v for k,v in zip(tools.keys,tools.values)if isinstance(k,ast.Constant)and k.value=='psql');self.assertEqual(ast.unparse(psql),'native_psql16(repo)')
  job=(REPO/'.github/workflows/zig-agents.yml').read_text().split('\n  aleo-full-case:',1)[1].split('  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0];self.assertIn('bubblewrap python3 postgresql-client-16 libcurl4t64 libssl3t64',job)
 def test_native16_apt_inverse_is_exact_in_both_existing_workflow_helpers(self):
  text=(REPO/'.github/workflows/zig-agents.yml').read_text();helper=next(n for n in ast.parse((REPO/'zig/bench/paired_linux_test.py').read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow');scope={'hashlib':hashlib};exec(compile(ast.Module([helper],type_ignores=[]),'actual paired workflow inverse','exec'),scope)
  normalized=ordinary_native_http_workflow(text);self.assertEqual(scope['ordinary_native_http_workflow'](text),normalized)
  line='          sudo apt-get install -y --no-install-recommends bubblewrap python3 postgresql-client-16 libcurl4t64 libssl3t64\n';self.assertEqual(text.count(line),1)
  for changed in [text.replace(line,''),text.replace(line,line+line),text.replace(line,line.replace('postgresql-client-16','postgresql-client-17'))]:
   for fn in [ordinary_native_http_workflow,scope['ordinary_native_http_workflow']]:
    with self.assertRaisesRegex(AssertionError,'Exact Aleo native PostgreSQL16 install required'):fn(changed)
 def test_wrapper_wrong_arch_nonexecutable_symlink_and_missing_refuse(self):
  native=self.root/'psql'
  for label in ['wrapper','arm64','nonexecutable','symlink','missing']:
   if native.exists()or native.is_symlink():native.unlink()
   if label!='missing':native.write_bytes(b'#!/usr/bin/perl\n'if label=='wrapper'else self.elf(183 if label=='arm64'else 62));native.chmod(0o644 if label=='nonexecutable'else 0o755)
   if label=='symlink':target=self.root/'foreign';target.write_bytes(self.elf());target.chmod(0o755);native.unlink();native.symlink_to(target)
   with self.subTest(label=label),mock.patch.object(m,'Path',side_effect=lambda value:native if str(value)=='/usr/lib/postgresql/16/bin/psql'else pathlib.Path(value)),mock.patch.object(m,'module',return_value=self.tools),self.assertRaises(ValueError):m.native_psql16(REPO)

class ActivatedPolicyFixture(unittest.TestCase):
 def test_real_activation_cannot_turn_negative_policy_fixture_into_authority(self):
  active={**m.FIXED,'root_approved':True,'selected_mode':'ReleaseSafe','runtime_source_commit':'a'*40,'requests':{mode:{'path':'not-to-be-read.json','bytes':1,'sha256':'b'*64}for mode in m.MODES},'qualified_cohort':{'path':'not-to-be-read.json','bytes':1,'sha256':'b'*64},'qualified_docker':{'path':'not-to-be-read.json','bytes':1,'sha256':'b'*64},'required_source':[{'path':'not-to-be-read.json','bytes':1,'sha256':'b'*64}]}
  case=Policy('test_false_policy_is_inert_for_both_modes_before_any_effect')
  try:
   with mock.patch.object(pathlib.Path,'read_text',return_value=json.dumps(active)):case.setUp()
   self.assertIs(case.value['root_approved'],False)
   for key in ['selected_mode','runtime_source_commit','qualified_cohort','qualified_docker','required_source']:self.assertIsNone(case.value[key])
   self.assertEqual(case.value['requests'],{mode:None for mode in m.MODES})
   case.test_false_policy_is_inert_for_both_modes_before_any_effect()
  finally:case.doCleanups()

class SelectedMode(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def descriptor(self,value):
  p=self.root/'policy.json';p.write_text(json.dumps(value));return m.pin(p)
 def inert(self):
  return {**m.FIXED,'root_approved':False,'selected_mode':None,'runtime_source_commit':None,'requests':dict.fromkeys(m.MODES),'qualified_cohort':None,'qualified_docker':None,'required_source':None}
 def relative(self,path):
  return {**m.pin(path),'path':path.relative_to(self.root).as_posix()}
 def approved(self,selected):
  # Source-only synthetic policy fixture; no prerequisite or native acceptance.
  sources=[]
  for source in sorted(m.source_policy_paths(REPO)):
   source=pathlib.Path(source);relative=source.relative_to(REPO);target=self.root/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(source.read_bytes());sources.append(self.relative(target))
  value=self.inert();value.update(root_approved=True,selected_mode=selected,runtime_source_commit='a'*40,required_source=sources)
  for key,body in [('qualified_cohort',{'synthetic_parser_fixture':True}),('qualified_docker',{'passed':True,'synthetic_parser_fixture':True})]:
   p=self.root/(key+'.json');p.write_text(json.dumps(body));value[key]=self.relative(p)
  for mode in m.MODES:
   p=self.root/('transport-'+mode+'.json');p.write_text(json.dumps({'root_approved':True,'scenario':'cosmosnative','mode':mode,'producer_source_commit':value['runtime_source_commit']}));value['requests'][mode]=self.relative(p)
  return value
 def select(self,row,mode):
  # Execute the actual --select branch AST; no subprocess or custom selector.
  tree=ast.parse(pathlib.Path(m.__file__).read_bytes());entry=next(n for n in tree.body if isinstance(n,ast.If)and isinstance(n.test,ast.Compare)and ast.unparse(n.test)=="__name__ == '__main__'")
  branch=next(n for n in entry.body if isinstance(n,ast.If)and ast.unparse(n.test)=='args.select');printed=[];output=self.root/'GITHUB_OUTPUT'
  scope={**m.__dict__,'args':N(policy=row['path'],policy_sha=row['sha256'],mode=mode),'os':N(environ={'GITHUB_WORKSPACE':str(self.root),'GITHUB_OUTPUT':str(output)}),'print':printed.append}
  exec(compile(ast.Module(body=branch.body,type_ignores=[]),'actual-fullcase-select-branch','exec'),scope)
  return json.loads(printed[-1]),output.read_text().splitlines()[-1]
 def test_false_null_is_inert_and_missing_or_nonnull_selection_refuses(self):
  value=self.inert();row=self.descriptor(value)
  for mode in m.MODES:self.assertEqual(m.policy(row['path'],row['sha256'],mode,self.root),(value,None))
  for selected in [False,0,'ReleaseSafe','ReleaseFast','',[],{}]:
   row=self.descriptor({**value,'selected_mode':selected})
   with self.subTest(selected=selected),self.assertRaisesRegex(ValueError,'selected'):m.policy(row['path'],row['sha256'],'ReleaseSafe',self.root)
  value.pop('selected_mode');row=self.descriptor(value)
  with self.assertRaisesRegex(ValueError,'fixed full-case policy'):m.policy(row['path'],row['sha256'],'ReleaseSafe',self.root)
 def test_approved_selection_requires_exact_enum_before_authority_reads(self):
  for selected in [None,False,0,'','safe','releasesafe','ReleaseSafe ',[],{}]:
   value={**self.inert(),'root_approved':True,'selected_mode':selected};row=self.descriptor(value)
   with self.subTest(selected=selected),mock.patch.object(m,'policy_pin',side_effect=AssertionError('authority read before selection validation')),self.assertRaisesRegex(ValueError,'selected'):m.policy(row['path'],row['sha256'],'ReleaseSafe',self.root)
 def test_selected_both_modes_validate_full54_and_both_transports(self):
  for mode in m.MODES:
   value=self.approved(mode);row=self.descriptor(value);out,authority=m.policy(row['path'],row['sha256'],mode,self.root)
   self.assertEqual(authority,row);self.assertEqual(out['selected_mode'],mode);self.assertEqual(len(out['required_source']),54);self.assertEqual(set(out['requests']),set(m.MODES));self.assertTrue(all(out[k]==v for k,v in m.FIXED.items()))
   result,line=self.select(row,mode);self.assertEqual(result,{'enabled':True,'native_case_acceptance':False});self.assertEqual(line,'enabled=true')
   other=next(name for name in m.MODES if name!=mode);self.assertIsNone(m.policy(row['path'],row['sha256'],other,self.root)[1]);result,line=self.select(row,other);self.assertEqual(result,{'enabled':False,'native_case_acceptance':False});self.assertEqual(line,'enabled=false')
 def test_unselected_select_and_execute_are_inert_despite_stale_selected_authority(self):
  for selected in m.MODES:
   requested=next(mode for mode in m.MODES if mode!=selected);value={**self.inert(),'root_approved':True,'selected_mode':selected};row=self.descriptor(value)
   with mock.patch.object(m,'policy_pin',side_effect=AssertionError('unselected authority read')),mock.patch.object(m,'module',side_effect=AssertionError('unselected import')),mock.patch.object(m,'job_observation',side_effect=AssertionError('unselected API')),mock.patch.object(m.subprocess,'Popen',side_effect=AssertionError('unselected child')):
    self.assertEqual(m.policy(row['path'],row['sha256'],requested,self.root),(value,None));result,line=self.select(row,requested);self.assertEqual(result,{'enabled':False,'native_case_acceptance':False});self.assertEqual(line,'enabled=false');self.assertEqual(m.execute(row['path'],row['sha256'],requested,{'GITHUB_WORKSPACE':str(self.root)}),{'enabled':False,'native_case_acceptance':False})
   self.assertEqual({p.name for p in self.root.iterdir()},{'policy.json','GITHUB_OUTPUT'})
 def test_selected_stale_Source_or_header_refuses_for_both_modes(self):
  for mode,kind in itertools.product(m.MODES,['source','cohort','docker']):
   value=self.approved(mode);path=self.root/(value['required_source'][0]['path']if kind=='source'else value['qualified_'+kind]['path']);path.write_bytes(path.read_bytes()+b' ');row=self.descriptor(value)
   with self.subTest(mode=mode,kind=kind),self.assertRaisesRegex(ValueError,'artifact changed'):m.policy(row['path'],row['sha256'],mode,self.root)
 def test_selected_needs_unselected_transport_and_complete_Source_membership(self):
  for mode,kind in itertools.product(m.MODES,['transport','source_missing','source_duplicate','docker_not_passed']):
   value=self.approved(mode)
   if kind=='transport':
    other=next(name for name in m.MODES if name!=mode);p=self.root/value['requests'][other]['path'];request=json.loads(p.read_text());request['root_approved']=False;p.write_text(json.dumps(request));value['requests'][other]=self.relative(p)
   elif kind=='source_missing':value['required_source'].pop()
   elif kind=='source_duplicate':value['required_source'].append(copy.deepcopy(value['required_source'][0]))
   else:
    p=self.root/value['qualified_docker']['path'];p.write_text('{"passed":false}');value['qualified_docker']=self.relative(p)
   row=self.descriptor(value)
   with self.subTest(mode=mode,kind=kind),self.assertRaises(ValueError):m.policy(row['path'],row['sha256'],mode,self.root)
 def test_requested_mode_remains_validated_even_when_unselected(self):
  value={**self.inert(),'root_approved':True,'selected_mode':'ReleaseSafe'};row=self.descriptor(value)
  for requested in [None,False,'','safe','ReleaseOther']:
   with self.subTest(requested=requested),self.assertRaisesRegex(ValueError,'both mode request'):m.policy(row['path'],row['sha256'],requested,self.root)

class PolicyPins(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def test_relative_policy_resolves_only_pinned_current_checkout_bytes(self):
  p=self.root/'public.json';p.write_text('{}');row=m.pin(p);relative={**row,'path':'public.json'}
  self.assertEqual(m.policy_pin(relative,self.root),row)
  chunked={**relative,'sha256':{'sha256_hex_chunks':[row['sha256'][:32],row['sha256'][32:]]}};self.assertEqual(m.policy_pin(chunked,self.root),row)
  with self.assertRaises(ValueError):m.policy_pin({**chunked,'sha256':{**chunked['sha256'],'unexpected':True}},self.root)
  p.write_text('changed')
  with self.assertRaises(ValueError):m.policy_pin(relative,self.root)
 def test_absolute_parent_alias_and_symlink_policy_inputs_reject(self):
  p=self.root/'public.json';p.write_text('{}');row=m.pin(p)
  for name in [str(p),'../public.json','./public.json','a//b','a\\b']:
   with self.subTest(name=name),self.assertRaises(ValueError):m.policy_pin({**row,'path':name},self.root)
  (self.root/'alias.json').symlink_to(p)
  with self.assertRaises(ValueError):m.policy_pin({**row,'path':'alias.json'},self.root)
 def test_source_inventory_has_no_caller_selected_subset(self):
  for relative,contents in [('zig/tools/aleo_linux_case/case_specs.py',"CASE_CODE=('case_specs.py','inner.py')"),('zig/tools/aleo_linux_sdk/sdk_specs.py',"CODE=('receipts.py','sdk_build.py')")]:
   p=self.root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(contents)
  paths=m.source_policy_paths(self.root)
  for required in ['zig/tools/aleo_linux_case/inner.py','zig/tools/aleo_linux/kernel_probe.py','zig/tools/aleo_linux_sdk/sdk_build.py','zig/integration/aleo_process.ts','zig/bench/native_case_ci.py']:
   # kernel_probe is in real SDK CODE; this synthetic CODE intentionally lacks it.
   if required.endswith('kernel_probe.py'):continue
   self.assertIn(str(self.root/required),paths)
  self.assertIn(str(self.root/'zig/tools/aleo_linux/receipts.py'),paths)

class InteropCommandContract(unittest.TestCase):
 def test_both_manifest_commands_satisfy_actual_Linux_reader_API(self):
  import argparse
  producer_tree=ast.parse((HERE/'ci_fullcase.py').read_text())
  execute=next(n for n in producer_tree.body if isinstance(n,ast.FunctionDef)and n.name=='execute')
  calls=[n for n in ast.walk(execute)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='run'and n.args and isinstance(n.args[0],ast.BinOp)and isinstance(n.args[0].left,ast.Constant)and n.args[0].left.value=='interop-']
  self.assertEqual(len(calls),1)
  reader_tree=ast.parse((REPO/'zig/integration/native_rows_interop.py').read_text())
  main=next(n for n in reader_tree.body if isinstance(n,ast.FunctionDef)and n.name=='main')
  parser_nodes=[]
  for node in main.body:
   if isinstance(node,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='args'for t in node.targets):break
   parser_nodes.append(node)
  ns={'argparse':argparse,'pathlib':pathlib,'__doc__':'actual reader argument contract'}
  exec(compile(ast.Module(body=parser_nodes,type_ignores=[]),'actual reader argparse','exec'),ns)
  manifest=next(n for n in main.body if isinstance(n,ast.If)and isinstance(n.test,ast.Compare)and isinstance(n.test.left,ast.Attribute)and n.test.left.attr=='tool_manifest')
  refusal=next(n.test for n in manifest.body if isinstance(n,ast.If))
  for mode in m.MODES:
   writer={'path':'/owned/'+mode,'sha256':'a'*64};tools={name:{'path':'/owned/'+name,'sha256':'b'*64}for name in ['ziggy-native-rows','ziggy-rocks-oracle','ziggy-rust-reference']}
   values={'python':pathlib.Path('/usr/bin/python3.12'),'repo':REPO,'writer':writer,'tools':tools,'manifest':{'path':'/owned/manifest.json','sha256':'c'*64},'authority':{'runtime_source_commit':'d'*40},'output':pathlib.Path('/owned/interop-'+mode+'.json')}
   command=eval(compile(ast.Expression(calls[0].args[1]),'actual fullcase interop argv','eval'),values)
   args=ns['parser'].parse_args([str(x)for x in command[4:]])
   self.assertFalse(eval(compile(ast.Expression(refusal),'actual Linux reader admission','eval'),{'args':args,'sys':N(platform='linux')}))
   # The former override combination really is refused by the pinned reader API.
   args.old_oracle=pathlib.Path('/owned/forbidden-override')
   self.assertTrue(eval(compile(ast.Expression(refusal),'actual Linux reader admission','eval'),{'args':args,'sys':N(platform='linux')}))
class FailedCaseTail(unittest.TestCase):
 def script(self):
  import textwrap
  job=(REPO/'.github/workflows/zig-agents.yml').read_text().split('\n  aleo-full-case:',1)[1]
  step=job.split('      - name: Retain bounded failure tail from token-free laboratory case\n',1)[1].split('      - uses:',1)[0]
  self.assertIn("if: failure() && steps.authority.outputs.enabled == 'true'",step)
  return textwrap.dedent(step.split("python3 -I -B - <<'PYTHON'\n",1)[1].split('          PYTHON',1)[0])
 def fixture(self):
  temp=tempfile.TemporaryDirectory(prefix='ziggy-case-failure-tail-');self.addCleanup(temp.cleanup);root=pathlib.Path(temp.name);case=root/'aleo-fullcase-123-1-releasesafe';case.mkdir();return root,case
 def capture(self,root):
  import os
  with mock.patch.dict(os.environ,{'MODE':'ReleaseSafe','RUNNER_TEMP':str(root),'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','PRIVATE_SENTINEL':'never-read'},clear=True):exec(compile(self.script(),'actual bounded failure-tail workflow','exec'),{})
 def test_actual_workflow_retains_only64KiB_tail_and_fingerprint(self):
  root,case=self.fixture();raw=b'prefix'+b'x'*70000;source=case/'full-case.private.log';source.write_bytes(raw);self.capture(root)
  target=case/'public/full-case-failure-tail.log';meta=json.loads((case/'public/full-case-failure-tail.json').read_text());self.assertEqual(target.read_bytes(),raw[-65536:]);self.assertEqual(source.read_bytes(),raw);self.assertEqual(target.stat().st_mode&0o777,0o600)
  self.assertEqual(meta['sha256'],hashlib.sha256(raw[-65536:]).hexdigest());self.assertEqual(meta['retained_bytes'],65536);self.assertEqual(meta['original_bytes'],len(raw));self.assertTrue(meta['truncated']);self.assertFalse(meta['native_or_performance_credit']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(meta))
 def test_actual_workflow_short_log_is_complete_and_never_native_acceptance(self):
  root,case=self.fixture();raw=b'known laboratory failure\n';(case/'full-case.private.log').write_bytes(raw);self.capture(root);self.assertEqual((case/'public/full-case-failure-tail.log').read_bytes(),raw);self.assertFalse(json.loads((case/'public/full-case-failure-tail.json').read_text())['truncated'])
 def test_actual_workflow_missing_or_symlink_log_never_reads_foreign_file(self):
  root,case=self.fixture();self.capture(root);self.assertFalse((case/'public').exists());other=root/'unrelated';other.write_bytes(b'PRIVATE_SENTINEL');(case/'full-case.private.log').symlink_to(other);self.capture(root);self.assertFalse((case/'public').exists());self.assertEqual(other.read_bytes(),b'PRIVATE_SENTINEL')
class Budget(unittest.TestCase):
 def observation(self,**changes):
  now=datetime.datetime(2026,11,8,12,0,0,tzinfo=datetime.timezone.utc);self.now=int(now.timestamp()*10**9)
  job={'id':123,'run_id':456,'run_attempt':1,'head_sha':'a'*40,'name':'aleo-full-case (ReleaseSafe)','status':'in_progress','conclusion':None,'started_at':'2026-11-08T11:00:00Z'};job.update(changes)
  return m.observed_budget(job,{'date':'Sun, 08 Nov 2026 12:00:00 GMT'},run_id=456,attempt=1,head='a'*40,mode='ReleaseSafe',wall_before_ns=self.now-10**9,wall_after_ns=self.now,mono_after_ns=100)
 def test_actual_start_is_not_reset_and_cleanup195min_is_mandatory(self):
  out=self.observation();self.assertEqual(out['conservative_remaining_ns'],(270*60-6)*10**9)
  boundary=out['observed_monotonic_ns']+out['conservative_remaining_ns']-195*60*10**9
  self.assertEqual(m.require_launch_budget(out,boundary),195*60*10**9)
  with self.assertRaises(ValueError):m.require_launch_budget(out,boundary+1)
 def test_wrong_job_mode_head_attempt_and_terminal_status_reject(self):
  for changes in [{'run_id':789},{'run_attempt':2},{'head_sha':'b'*40},{'name':'aleo-full-case (ReleaseFast)'},{'status':'completed'},{'conclusion':'success'}]:
   with self.subTest(changes=changes),self.assertRaises(ValueError):self.observation(**changes)
 def test_time_cannot_move_back_to_buy_budget(self):
  out=self.observation()
  with self.assertRaises(ValueError):m.require_launch_budget(out,99)
 def test_future_api_start_and_clock_disagreement_reject(self):
  # Negative elapsed timestamps cannot provide a new330min budget.
  with self.assertRaises(ValueError):self.observation(started_at='2026-11-08T13:00:00Z')
class FinalGate(unittest.TestCase):
 def good(self):return {'source_unchanged':True,'proof_owner_crossbound':True,'error_type':None,'command_waits':[{'name':n,'actual_parent_wait':True,'exit_code':0,'signals':[],'cleanup_errors':[],'started_monotonic_ns':1,'maximum_wall_seconds':1,'original_deadline_ns':1000000001,'completion_check_ns':2}for n in m.PHASES]}
 def test_success_requires_every_actual_phase_and_crossbound_proof(self):self.assertTrue(m.final_pass(self.good()))
 def test_no_component_postcondition_can_be_ignored(self):
  for key,value in [('source_unchanged',False),('proof_owner_crossbound',False),('error_type','Cancellation')]:
   bad=self.good();bad[key]=value
   with self.subTest(key=key):self.assertFalse(m.final_pass(bad))
  for key,value in [('actual_parent_wait',False),('exit_code',True),('exit_code',1),('signals',['SIGINT'])]:
   bad=self.good();bad['command_waits'][-1][key]=value
   with self.subTest(key=key):self.assertFalse(m.final_pass(bad))
  bad=self.good();bad['command_waits'].pop();self.assertFalse(m.final_pass(bad))

class Custody(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def test_command_actual_wait_and_no_signals_required(self):
  child=mock.Mock(pid=123);child.wait.return_value=0;cmd=m.Commands(self.root,{'PATH':'/usr/bin:/bin'})
  with mock.patch.object(m.subprocess,'Popen',return_value=child):cmd.run('actual-command',['/fixed/tool'],10)
  self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertEqual(cmd.rows[0]['exit_code'],0);self.assertEqual(cmd.rows[0]['signals'],[])
 def test_timeout_graceful_exit0_still_fails_proof(self):
  child=mock.Mock(pid=123);child.wait.side_effect=[subprocess.TimeoutExpired('/fixed/tool',1),0,0];child.poll.return_value=None;cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg')as kill:
   with self.assertRaises(subprocess.TimeoutExpired):cmd.run('actual-timeout',['/fixed/tool'],1)
  self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertEqual(cmd.rows[0]['signals'],['SIGINT']);kill.assert_called_once_with(123,m.signal.SIGINT)
 def test_cancellation_is_not_eintr_and_preserves_wait(self):
  self.assertFalse(issubclass(m.TaskInterrupted,InterruptedError))
  child=mock.Mock(pid=123);child.wait.side_effect=[m.TaskInterrupted('stop'),0,0];child.poll.return_value=None;cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg'):
   with self.assertRaises(m.TaskInterrupted):cmd.run('actual-cancel',['/fixed/tool'],1)
  self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertEqual(cmd.rows[0]['interruption_type'],'TaskInterrupted')
class DeadlineAndLaunchUnwind(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def test_late_zero_is_retained_actual_wait_but_fails_original_deadline(self):
  child=mock.Mock(pid=123);child.wait.return_value=0;cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.time,'monotonic_ns',side_effect=[0,0,11*10**9,11*10**9]):
   with self.assertRaisesRegex(ValueError,'monotonic'):cmd.run('late-zero',['/fixed/tool'],10)
  row=cmd.rows[0];self.assertTrue(row['actual_parent_wait']);self.assertEqual(row['exit_code'],0);self.assertEqual(row['original_deadline_ns'],10*10**9);self.assertEqual(row['completion_check_ns'],11*10**9);self.assertFalse(m.phase_fence(row))
 def test_postspawn_pid_bookkeeping_cancellation_still_waits_actual_child(self):
  child=mock.Mock();type(child).pid=mock.PropertyMock(side_effect=[m.TaskInterrupted('original-postspawn'),123]);child.poll.return_value=None;child.wait.return_value=0;cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg')as kill:
   with self.assertRaisesRegex(m.TaskInterrupted,'original-postspawn'):cmd.run('postspawn-cancel',['/fixed/tool'],10)
  child.wait.assert_called_once();kill.assert_called_once_with(123,m.signal.SIGINT);self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertEqual(cmd.rows[0]['pid'],123)
 def test_signal_failure_cannot_skip_actual_wait_or_replace_primary(self):
  child=mock.Mock(pid=123);child.poll.return_value=None;original=subprocess.TimeoutExpired('/fixed/tool',10);child.wait.side_effect=[original,0];cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg',side_effect=OSError('signal failed')):
   with self.assertRaises(subprocess.TimeoutExpired)as observed:cmd.run('signal-failed',['/fixed/tool'],10)
  self.assertIs(observed.exception,original);self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertIn('signal:OSError',cmd.rows[0]['cleanup_errors']);self.assertEqual(child.wait.call_count,2)

class CaseLogOwnership(unittest.TestCase):
 def test_actual_inner_launch_cannot_reopen_supervisor_case_logs(self):
  outer=next(n for n in ast.parse((HERE/'case_supervisor.py').read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='run')
  launch=next(n for n in ast.walk(outer)if isinstance(n,ast.FunctionDef)and n.name=='launch')
  opens=[n for n in launch.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id in {'out','err'}for t in n.targets)]
  self.assertEqual(len(opens),2)
  source=(HERE/'inner.py').read_text();run=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)and n.name=='run')
  inner=next(n for n in run.body if isinstance(n,ast.FunctionDef)and n.name=='launch')
  call=next(n for n in ast.walk(run)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='main'for t in n.targets))
  with tempfile.TemporaryDirectory()as directory:
   control=pathlib.Path(directory);space={'control':control,'label':'case'}
   exec(compile(ast.Module(body=opens,type_ignores=[]),'actual-supervisor-log-creation','exec'),space)
   for name in ('out','err'):space[name].write(b'preserve-outer-log');space[name].close()
   before={p.name:p.read_bytes()for p in control.iterdir()}
   child=mock.Mock();popen=mock.Mock(return_value=child);streams=[];children=[]
   env={'control':control,'spec':{'original_deadline_ns':2,'exact_node_argv':['admitted-node','admitted-launcher']},'cancelled':N(is_set=lambda:False),'time':N(monotonic_ns=lambda:1),'need':m.need,'subprocess':N(Popen=popen),'streams':streams,'children':children}
   exec(compile(ast.Module(body=[inner],type_ignores=[]),'actual-inner-launch-definition','exec'),env)
   old=copy.deepcopy(call);old.value.args[0]=ast.Constant(value='case');ast.fix_missing_locations(old)
   with self.assertRaises(FileExistsError):exec(compile(ast.Module(body=[old],type_ignores=[]),'old-colliding-call','exec'),env)
   popen.assert_not_called()
   try:exec(compile(ast.Module(body=[call],type_ignores=[]),'actual-distinct-inner-call','exec'),env)
   finally:
    for stream in streams:stream.close()
   popen.assert_called_once();self.assertEqual(children,[('node-case',child)])
   self.assertEqual({p.name:p.read_bytes()for p in control.iterdir()if p.name in before},before)
   self.assertEqual({p.name for p in control.iterdir()},set(before)|{'node-case.stdout','node-case.stderr'})

class ClosedCaseFailure(unittest.TestCase):
 def test_typed_projection_retains_io_guard_and_actual_waits_without_private_values(self):
  with tempfile.TemporaryDirectory()as directory:
   case=pathlib.Path(directory).resolve()/'case';(case/'control').mkdir(parents=True);case.with_suffix('.owner').mkdir()
   (case/'result.json').write_text(json.dumps({'passed':False,'error':'ValueError:actual isolated Aleo case failed','direct_waits':[{'phase':'case','pid':123,'actual_parent_wait':True,'exit_code':1,'argv':['PRIVATE_SENTINEL']}],'argv':['PRIVATE_SENTINEL'],'gate_failed':None}))
   (case/'control/inner-result.json').write_text(json.dumps({'passed':False,'error':"FileExistsError:[Errno 17] PRIVATE_SENTINEL",'actual_waits':[],'signals':[],'cleanup_errors':['PRIVATE_SENTINEL']}))
   (case.with_suffix('.owner')/'owner.json').write_text(json.dumps({'passed':False,'error':'ValueError:actual case service failed','client_wait':{'pid':456,'actual_parent_wait':True,'exit_code':1,'private':'PRIVATE_SENTINEL'},'cleanup':{'owned_cgroup_absent':True,'private':'PRIVATE_SENTINEL'}}))
   value=m.case_failure_diagnostics(case,REPO);text=json.dumps(value);self.assertNotIn('PRIVATE_SENTINEL',text);self.assertNotIn(str(case),text);self.assertFalse(value['native_or_performance_credit'])
   payload=value['records']['payload'];self.assertEqual(payload['error']['fixed_Source_guard']['guard'],'actual isolated Aleo case failed');self.assertEqual(payload['direct_waits']['rows'],[{'pid':123,'exit_code':1,'actual_parent_wait':True,'phase':'case'}])
   self.assertEqual(value['records']['namespace']['error'],{'present':True,'class':'FileExistsError','errno':17});self.assertEqual(value['records']['service']['cleanup'],{'owned_cgroup_absent':True});self.assertEqual(value['records']['driver']['status'],'absent')
 def test_projection_refuses_alias_and_oversized_metadata_and_never_reads_logs(self):
  with tempfile.TemporaryDirectory()as directory:
   case=pathlib.Path(directory).resolve()/'case';case.mkdir();outside=case.parent/'private.json';outside.write_text('{"private":"PRIVATE_SENTINEL"}');(case/'result.json').symlink_to(outside);(case/'private.log').write_text('PRIVATE_SENTINEL')
   value=m.case_failure_diagnostics(case,REPO);self.assertEqual(value['records']['payload']['status'],'unsafe-path');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(value))
   (case/'result.json').unlink()
   with (case/'result.json').open('wb')as output:output.truncate(32*1024**2+1)
   with mock.patch.object(m,'pin',side_effect=AssertionError('oversized metadata hashed'))as pin_mock,mock.patch.object(m,'load',side_effect=AssertionError('oversized metadata loaded'))as load_mock:
    value=m.case_failure_diagnostics(case,REPO);pin_mock.assert_not_called();load_mock.assert_not_called()
   self.assertEqual(value['records']['payload']['status'],'unavailable');self.assertFalse(value['native_or_performance_credit'])


class StartupFailureProjection(unittest.TestCase):
 def fixture(self,case):
  path=REPO/'zig/tools/aleo_linux_case/case_delegate.py';row=m.pin(path);marker={'schema':1,'kind':'aleo-case-service-startup-failure-v1','stage':'prepare-controllers','error_class':'PermissionError','errno':13,'observed_monotonic_ns':time.monotonic_ns(),'frames':[{'source':'case_delegate.py','line':1,'bytes':row['bytes'],'sha256':row['sha256']}]}
  diagnostics={'schema':1,'kind':'aleo-case-service-failure-metadata-v1','files':{'stdout':{'status':'available','bytes':0,'sha256':hashlib.sha256(b'').hexdigest()},'stderr':{'status':'available','bytes':99,'sha256':'a'*64}},'startup':{'status':'available','record':marker},'raw_logs_argv_environment_exported':False}
  value={'passed':False,'error':'ValueError:actual case service failed','client_wait':{'pid':123,'actual_parent_wait':True,'exit_code':1},'service_failure_diagnostics':diagnostics,'private':{'authorization':'PRIVATE_SENTINEL'}};directory=case.with_suffix('.owner');directory.mkdir();path=directory/'owner.json';path.write_text(json.dumps(value));return path,value
 def test_actual_already_uploaded_public_caller_reconstructs_validated_stage_frames_logs(self):
  with tempfile.TemporaryDirectory()as root:
   case=pathlib.Path(root).resolve()/'case';path,value=self.fixture(case);result=m.case_failure_diagnostics(case,REPO);service=result['records']['service'];self.assertEqual(service['status'],'available');self.assertEqual(service['error']['fixed_Source_guard']['guard'],'actual case service failed');diagnostic=service['service_failure_diagnostics'];self.assertEqual(diagnostic['startup']['record']['stage'],'prepare-controllers');self.assertEqual(diagnostic['startup']['record']['errno'],13);self.assertEqual(diagnostic['files']['stderr']['bytes'],99);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result));self.assertNotIn(str(case),json.dumps(result));self.assertFalse(result['native_or_performance_credit'])
 def test_public_malformed_private_or_stale_source_cannot_mask_original_service_error(self):
  with tempfile.TemporaryDirectory()as root:
   case=pathlib.Path(root).resolve()/'case';path,original=self.fixture(case)
   for change in ['extra','nested','schema','bool-clock','wrong-source','wrong-hash','wrong-stage']:
    value=copy.deepcopy(original);d=value['service_failure_diagnostics'];v=d['startup']['record']
    if change=='extra':d['private']='PRIVATE_SENTINEL'
    if change=='nested':v['frames'][0]['authorization']={'private':'PRIVATE_SENTINEL'}
    if change=='schema':d['schema']=True
    if change=='bool-clock':v['observed_monotonic_ns']=True
    if change=='wrong-source':v['frames'][0]['source']='PRIVATE_SENTINEL'
    if change=='wrong-hash':v['frames'][0]['sha256']='b'*64
    if change=='wrong-stage':v['stage']='PRIVATE_SENTINEL'
    path.write_text(json.dumps(value));result=m.case_failure_diagnostics(case,REPO);service=result['records']['service'];self.assertEqual(service['status'],'available');self.assertEqual(service['error']['fixed_Source_guard']['guard'],'actual case service failed');self.assertEqual(service['service_failure_diagnostics'],{'status':'refused'},change);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
 def test_source_trace_fallback_stays_unobserved_and_no_performance_or_acceptance_credit(self):
  with tempfile.TemporaryDirectory()as root:
   case=pathlib.Path(root).resolve()/'case';path,value=self.fixture(case);d=value['service_failure_diagnostics'];d['startup']['status']='source-trace-only';d['startup']['record'].update(kind='aleo-case-service-source-trace-v1',stage='unobserved');path.write_text(json.dumps(value));result=m.case_failure_diagnostics(case,REPO);record=result['records']['service']['service_failure_diagnostics']['startup'];self.assertEqual(record['status'],'source-trace-only');self.assertEqual(record['record']['stage'],'unobserved');self.assertFalse(result['native_or_performance_credit'])


class DriverFailureProjection(unittest.TestCase):
 def sources(self):
  value=json.loads((REPO/'zig/tools/aleo_linux_case/ci_policy.PENDING.json').read_bytes())
  row=next(r for r in value['required_source']if r['path']=='zig/integration/aleo_process.ts')
  return [m.policy_pin(row,REPO)]
 def test_actual_public_caller_projects_pinned_stage_and_static_guard_without_raw_errors(self):
  with tempfile.TemporaryDirectory()as directory:
   case=pathlib.Path(directory).resolve()/'case';path=case/'data/case/result.json';path.parent.mkdir(parents=True)
   errors=['Docker daemon changed since resource approval','owned child cleanup: PermissionError: [Errno 13] PRIVATE_SENTINEL/path','owned command failed: PRIVATE_SENTINEL/token: private SDK reply','unclassified PRIVATE_SENTINEL']
   path.write_text(json.dumps({'passed':False,'stage':'actual-runtime-preflight','errors':errors,'evidence':{'authorization':'PRIVATE_SENTINEL'}}))
   result=m.case_failure_diagnostics(case,REPO,self.sources());record=result['records']['driver'];d=record['driver_observation'];self.assertEqual(record['errors_count'],4);self.assertEqual(d['status'],'observed');self.assertEqual(d['last_persisted_stage']['value'],'actual-runtime-preflight');self.assertGreater(d['last_persisted_stage']['source_literal_line'],0)
   self.assertEqual(d['source']['sha256'],self.sources()[0]['sha256']);self.assertEqual(d['error_rows'][0]['classification'],'DOCKER_DAEMON_CHANGED');self.assertEqual(d['error_rows'][1]['prefix']['kind'],'OWNED_CHILD_CLEANUP');self.assertEqual(d['error_rows'][1]['text_class'],'PermissionError');self.assertEqual(d['error_rows'][1]['text_errno'],13);self.assertEqual(d['error_rows'][2]['classification'],'OWNED_COMMAND_FAILED');self.assertEqual(d['error_rows'][3]['classification'],'UNCLASSIFIED')
   for raw,row in zip(errors,d['error_rows']):self.assertEqual((row['bytes'],row['sha256']),(len(raw.encode()),hashlib.sha256(raw.encode()).hexdigest()))
   text=json.dumps(result);self.assertNotIn('PRIVATE_SENTINEL',text);self.assertNotIn(str(case),text);self.assertIn('Text',d['basis'].replace('text','Text'));self.assertFalse(result['native_or_performance_credit'])
 def test_unknown_malicious_nested_or_nonstring_values_never_become_public_messages(self):
  value={'passed':False,'stage':{'PRIVATE_SENTINEL':'secret'},'errors':[{'name':'PRIVATE_SENTINEL','errno':13},'SDK private PRIVATE_SENTINEL','EACCES: PRIVATE_SENTINEL']}
  d=m.driver_failure_observation(value,REPO,self.sources());self.assertEqual(d['last_persisted_stage'],{'status':'unrecognized'});self.assertEqual(d['error_rows'][0],{'status':'non-string'});self.assertEqual(d['error_rows'][1]['classification'],'UNCLASSIFIED');self.assertEqual(d['error_rows'][2]['text_code'],'EACCES');self.assertNotIn('text_errno',d['error_rows'][2]);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d))
 def test_error_row_count_size_and_malformed_text_are_bounded_without_leakage(self):
  errors=['PRIVATE_SENTINEL'*6000,'\ud800']+['private']*20;d=m.driver_failure_observation({'passed':False,'stage':'preflight','errors':errors},REPO,self.sources());self.assertEqual(d['errors_count'],22);self.assertTrue(d['errors_truncated']);self.assertEqual(len(d['error_rows']),16);self.assertEqual(d['error_rows'][0]['status'],'oversized');self.assertEqual(d['error_rows'][0]['sha256'],hashlib.sha256(errors[0].encode()).hexdigest());self.assertEqual(d['error_rows'][1]['status'],'invalid-text');self.assertLess(len(json.dumps(d).encode()),32768);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d))
 def test_absent_duplicate_mismatched_or_unbounded_admitted_Source_refuses_classification(self):
  sources=self.sources();value={'passed':False,'stage':'actual-runtime-preflight','errors':['Docker daemon changed since resource approval']}
  for rows in (None,[],sources+sources,[{**sources[0],'sha256':'0'*64}],[{**sources[0],'sha256':{'private':'PRIVATE_SENTINEL'}}]):
   with self.subTest(rows=rows):self.assertEqual(m.driver_failure_observation(value,REPO,rows),{'status':'source-refused'})
  with mock.patch.object(pathlib.Path,'open',side_effect=AssertionError('oversized Source opened'))as opened:self.assertEqual(m.driver_failure_observation(value,REPO,[{**sources[0],'bytes':1024**2+1}]),{'status':'source-refused'});opened.assert_not_called()
 def test_Source_capture_is_single_bounded_read_and_replacement_bytes_fail_hash(self):
  value={'passed':False,'stage':'preflight','errors':[]};source=self.sources()[0];original=pathlib.Path.open;seen=[]
  def observe(path,*args,**kwargs):seen.append(path);return original(path,*args,**kwargs)
  with mock.patch.object(pathlib.Path,'open',autospec=True,side_effect=observe):d=m.driver_failure_observation(value,REPO,[source])
  self.assertEqual(d['status'],'observed');self.assertEqual(seen,[pathlib.Path(source['path'])])
  stream=mock.MagicMock();stream.__enter__.return_value.read.return_value=b'PRIVATE_SENTINEL changed Source'
  with mock.patch.object(pathlib.Path,'open',return_value=stream):self.assertEqual(m.driver_failure_observation(value,REPO,[source]),{'status':'source-refused'})
 def test_dynamic_readback_stage_reports_only_Source_pattern_and_epoch(self):
  for stage,kind in [('stopped-PRIVATE_SENTINEL-0','STOPPED_READBACK'),('readonly-files-PRIVATE_SENTINEL-1','READONLY_FILES')]:
   d=m.driver_failure_observation({'passed':False,'stage':stage,'errors':[]},REPO,self.sources());self.assertEqual(d['last_persisted_stage']['category'],kind);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d));self.assertNotIn('value',d['last_persisted_stage'])
  d=m.driver_failure_observation({'passed':False,'stage':'PRIVATE_SENTINEL','errors':[]},REPO,self.sources());self.assertEqual(d['last_persisted_stage'],{'status':'unrecognized'})
 def test_ambiguous_Source_stage_or_guard_literal_is_not_assigned_a_callsite(self):
  with tempfile.TemporaryDirectory()as directory:
   repo=pathlib.Path(directory).resolve();path=repo/'zig/integration/aleo_process.ts';path.parent.mkdir(parents=True);original=(REPO/'zig/integration/aleo_process.ts').read_bytes();path.write_bytes(original+b"\nawait save('actual-runtime-preflight', {});\n'Docker daemon changed since resource approval';\n")
   d=m.driver_failure_observation({'passed':False,'stage':'actual-runtime-preflight','errors':['Docker daemon changed since resource approval']},repo,[m.pin(path)]);self.assertEqual(d['last_persisted_stage'],{'status':'unrecognized'});self.assertEqual(d['error_rows'][0]['classification'],'UNCLASSIFIED')
 def test_success_is_not_classified_and_actual_failure_caller_supplies_admitted_Source(self):
  with mock.patch.object(pathlib.Path,'open',side_effect=AssertionError('success Source read')):self.assertEqual(m.driver_failure_observation({'passed':True},REPO,None),{'status':'not-failed'})
  tree=ast.parse(pathlib.Path(m.__file__).read_bytes());execute=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='execute');call=next(n for n in ast.walk(execute)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='case_failure_diagnostics');self.assertEqual(len(call.args),3);self.assertEqual(ast.unparse(call.args[2]),"authority['required_source']")



class HydrationFailureObservation(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve();self.repo=self.root/'repo';self.source=self.repo/'zig/integration/native_case_inputs.py';self.source.parent.mkdir(parents=True);self.source.write_bytes((REPO/'zig/integration/native_case_inputs.py').read_bytes());self.sources=[m.pin(self.source)];self.log=self.root/'hydrate.private.log'
  self.tree=ast.parse(self.source.read_bytes());helper=next(n for n in self.tree.body if isinstance(n,ast.FunctionDef)and n.name=='helper_cpu_admission_diagnostic');self.pure={'require':m.need,'json':json,'re':re};exec(compile(ast.Module([helper],type_ignores=[]),'<actual-pure-CPU-helper>','exec'),self.pure)
  self.guard='Helper/tools compiler-host CPU not covered by consumer';self.guard_line=next(n.lineno for n in ast.walk(self.tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='require'and len(n.args)>1 and isinstance(n.args[1],ast.Constant)and n.args[1].value==self.guard);self.require_line=next(i for i,line in enumerate(self.source.read_text().splitlines(),1)if line.strip()=='raise ValueError(message)')
 def cpu(self):return self.pure['helper_cpu_admission_diagnostic'](['avx','avx512f'],['avx'])
 def trace(self,message=None,path=None,line=None,kind='ValueError'):
  return f'Traceback (most recent call last):\n  File "{path or self.source}", line {line or self.guard_line}, in hydrate\n    require(...)\n  File "{path or self.source}", line {self.require_line}, in require\n    raise ValueError(message)\n{kind}: {message or self.guard}\n'
 def observe(self,wire):
  self.log.write_bytes(wire);return m.hydration_failure_observation(self.log,self.repo,self.sources)
 def test_exact_actual_CPU_record_trace_and_Source_guard_are_closed(self):
  record=self.cpu();value=self.observe(json.dumps(record,separators=(',',':')).encode()+b'\n'+self.trace().encode());self.assertEqual(value['status'],'observed');self.assertEqual(value['CPU_diagnostic'],{'status':'observed','record':record});self.assertEqual(value['trace']['error_class'],'ValueError');self.assertEqual(value['trace']['Source_guard'],{'category':'STATIC_NATIVE_INPUTS_REQUIRE','line':self.guard_line});self.assertEqual(value['trace']['NativeInputs_frames'],[{'line':self.guard_line},{'line':self.require_line}]);self.assertFalse(value['native_or_timing_or_CPU_admission_authority']);self.assertNotIn(str(self.root),json.dumps(value));self.assertLess(len(json.dumps(value)),40000)
 def test_CPU_record_requires_exact_types_counts_sorted_flags_and_canonical_JSON(self):
  variants=[]
  for update in [{'schema':True},{'required_count':True},{'missing_count':0},{'missing_flags':[]},{'required_flags':['avx512f','avx']},{'available_flags':['PRIVATE/URL']},{'admitted':True},{'private':'PRIVATE_TOKEN'}]:variants.append({**self.cpu(),**update})
  for value in variants:
   with self.subTest(update=value):self.assertEqual(self.observe(json.dumps(value,separators=(',',':')).encode()+b'\n'),{'status':'unavailable'})
  line=json.dumps(self.cpu(),separators=(',',':'))
  for wire in [line.replace('"avx"','"\\u0061vx"'),line.replace('"schema":1','"schema":1,"schema":1'),'PRIVATE_PREFIX'+line,line+'PRIVATE_SUFFIX',line+'\n'+line]:
   with self.subTest(wire=wire[:80]):self.assertEqual(self.observe(wire.encode()),{'status':'unavailable'})
 def test_unknown_error_suffix_and_foreign_frames_are_never_exported(self):
  value=self.observe(self.trace('PRIVATE_TOKEN https://private.invalid/SECRET').encode());self.assertEqual(value['CPU_diagnostic'],{'status':'unavailable'});self.assertIsNone(value['trace']['Source_guard']);self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn('https',json.dumps(value))
  for trace in [self.trace(path='/FOREIGN/'+str(self.source)),self.trace(kind='PrivateError'),'ValueError: '+self.guard+'\n']:
   self.assertEqual(self.observe(trace.encode()),{'status':'unavailable'})
  value=self.observe(self.trace(line=self.guard_line+1).encode());self.assertIsNone(value['trace']['Source_guard'])
 def test_Source_pins_pure_helper_body_and_duplicate_traces_refuse(self):
  self.log.write_text(self.trace());bad=[dict(self.sources[0],sha256='0'*64)]
  self.assertEqual(m.hydration_failure_observation(self.log,self.repo,bad),{'status':'unavailable'});self.assertEqual(m.hydration_failure_observation(self.log,self.repo,self.sources*2),{'status':'unavailable'})
  self.assertEqual(self.observe((self.trace()+self.trace()).encode()),{'status':'unavailable'})
  self.source.write_bytes(self.source.read_bytes().replace(b"'native-case-helper-cpu-admission'",b"'PRIVATE_CPU_KIND'"));self.sources=[m.pin(self.source)];self.assertEqual(self.observe(json.dumps(self.cpu(),separators=(',',':')).encode()),{'status':'unavailable'})
 def test_log_symlink_oversize_and_CPU_line_bound_do_not_read_raw_fallback(self):
  self.log.symlink_to(self.source);self.assertEqual(m.hydration_failure_observation(self.log,self.repo,self.sources),{'status':'unavailable'});self.log.unlink()
  with self.log.open('wb')as stream:stream.truncate(1024**2+1)
  opened=[];real=m.os.open
  def tracked(path,*args,**kwargs):opened.append(str(path));return real(path,*args,**kwargs)
  with mock.patch.object(m.os,'open',side_effect=tracked):self.assertEqual(m.hydration_failure_observation(self.log,self.repo,self.sources),{'status':'unavailable'})
  self.assertNotIn(str(self.log),opened)
  self.assertEqual(self.observe(b'{"schema":1,"kind":"native-case-helper-cpu-admission",'+b' '*32768+b'}\n'),{'status':'unavailable'})
 def test_actual_finally_hook_only_failed_hydrate_and_preserves_primary_rows(self):
  tree=ast.parse(pathlib.Path(m.__file__).read_bytes());execute=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='execute');node=next(n for n in ast.walk(execute)if isinstance(n,ast.If)and any(isinstance(x,ast.Call)and isinstance(x.func,ast.Name)and x.func.id=='hydration_failure_observation'for x in ast.walk(n)))
  row={'name':'hydrate','actual_parent_wait':True,'exit_code':1,'signals':[],'cleanup_errors':[],'started_monotonic_ns':100,'original_deadline_ns':300*10**9+100,'maximum_wall_seconds':300,'completion_check_ns':101};primary='ValueError';projection={'status':'unavailable'}
  for changed,error,called in [(row,primary,True),({**row,'exit_code':0},primary,False),({**row,'name':'fetch'},primary,False),({**row,'name':'full-case'},primary,False),(row,None,False)]:
   rows=[copy.deepcopy(changed)];before=copy.deepcopy(rows);summary={'passed':False};callback=mock.Mock(return_value=projection);context={'error':error,'cmd':type('CommandFixture',(),{'rows':rows})(),'summary':summary,'root':self.root,'repo':self.repo,'authority':{'required_source':self.sources},'hydration_failure_observation':callback,'phase_fence':m.phase_fence}
   exec(compile(ast.Module([node],type_ignores=[]),'<actual-hydration-finally-hook>','exec'),context);self.assertEqual(callback.call_count,int(called));self.assertEqual(rows,before);self.assertEqual(context['error'],error);self.assertFalse(summary['passed'])
   if called:self.assertEqual(summary['hydrate_failure_observation'],projection);callback.assert_called_once_with(self.root/'hydrate.private.log',self.repo,self.sources)


class MigrationQueryProjection(unittest.TestCase):
 def sources(self):return [m.pin(REPO/'zig/integration/aleo_process.ts')]
 def observed(self):return {'status':'observed','lineCount':3,'names':['m20230309_000001_create_table_domain','m20261103_000019_scalar_notification_fields','m20230309_000001_create_table_domain'],'unrecognizedLineCount':0,'duplicateNameCount':1}
 def test_actual_failed_driver_caller_publishes_only_closed_names_and_counts(self):
  with tempfile.TemporaryDirectory()as directory:
   case=pathlib.Path(directory).resolve()/'case';path=case/'data/case/result.json';path.parent.mkdir(parents=True)
   path.write_text(json.dumps({'passed':False,'stage':'scraper-migration-query','errors':['PRIVATE_STDOUT_URI'],'evidence':{'scraper-migration-query':self.observed(),'private':'PRIVATE_STDOUT_URI'}}))
   result=m.case_failure_diagnostics(case,REPO,self.sources());row=result['records']['driver']['driver_observation'];self.assertEqual(row['migration_query'],self.observed());self.assertEqual(row['last_persisted_stage']['value'],'scraper-migration-query');self.assertNotIn('PRIVATE',json.dumps(result));self.assertFalse(result['native_or_performance_credit'])
 def test_absent_unavailable_and_original_count_mismatches_are_observations_only(self):
  source=(REPO/'zig/integration/aleo_process.ts').read_text()
  self.assertEqual(m.source_bound_migration_query(None,source),{'status':'absent'});self.assertEqual(m.source_bound_migration_query({'status':'unavailable'},source),{'status':'unavailable'})
  for count in [1,20,21,22,64]:
   row={'status':'observed','lineCount':count,'names':[],'unrecognizedLineCount':count,'duplicateNameCount':0};self.assertEqual(m.source_bound_migration_query(row,source),row)
 def test_malformed_extra_nonstring_boolean_oversized_and_private_names_refuse(self):
  source=(REPO/'zig/integration/aleo_process.ts').read_text()
  for value in [21,[],{'status':'unavailable','private':'PRIVATE'}, {**self.observed(),'private':'PRIVATE'}, {**self.observed(),'lineCount':True}, {**self.observed(),'lineCount':65}, {**self.observed(),'names':['PRIVATE_URI']}, {**self.observed(),'names':['m20230309_000001_'+('x'*97)]}, {**self.observed(),'unrecognizedLineCount':1}, {**self.observed(),'duplicateNameCount':0}]:
   with self.subTest(value=value):self.assertEqual(m.source_bound_migration_query(value,source),{'status':'refused'})
 def test_missing_or_ambiguous_Source_and_changed_admission_refuse(self):
  source=(REPO/'zig/integration/aleo_process.ts').read_text();row=self.observed()
  for changed in ['',source+"\nawait save('scraper-migration-query', {});",source.replace('migrationQueryObservation(versions)','unreviewed(versions)')]:
   self.assertEqual(m.source_bound_migration_query(row,changed),{'status':'refused'})
  result=m.driver_failure_observation({'passed':False,'errors':[],'evidence':{'scraper-migration-query':row}},REPO,[{**self.sources()[0],'sha256':'0'*64}]);self.assertEqual(result,{'status':'source-refused'})


class DriverCaughtErrorProjection(unittest.TestCase):
 def source(self):return (REPO/'zig/integration/aleo_process.ts').read_text()
 def diagnostic(self):
  point={'attempted_boundary':'sdk-worker-deploy-left','error_class':'TypeError','error_code':'EACCES','driver_frames':[{'line':1,'column':1}]}
  return {'schema':1,'kind':'aleo-source-bound-caught-error-v1','attempted_boundary':'sdk-deployment','error_class':'Error','error_code':None,'driver_frames':[{'line':1,'column':1}],'worker':point}
 def test_actual_failed_driver_public_projection_checks_pinned_Source_and_caught_worker_properties(self):
  with tempfile.TemporaryDirectory()as directory:
   root=pathlib.Path(directory).resolve();repo=root/'repo';source=repo/'zig/integration/aleo_process.ts';source.parent.mkdir(parents=True);source.write_text(self.source())
   for name in ['case_delegate.py','case_supervisor.py','inner.py']:
    target=repo/'zig/tools/aleo_linux_case'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((REPO/'zig/tools/aleo_linux_case'/name).read_bytes())
   case=root/'case';driver=case/'data/case/result.json';driver.parent.mkdir(parents=True)
   driver.write_text(json.dumps({'passed':False,'stage':'actual-runtime-preflight','errors':['PRIVATE_PRIMARY'],'evidence':{'caughtErrorDiagnostic':self.diagnostic(),'PRIVATE':'AUTH_TOKEN'}}))
   value=m.case_failure_diagnostics(case,repo,[m.pin(source)]);point=value['records']['driver']['driver_observation']['caught_error']
   self.assertEqual(point['status'],'observed');self.assertEqual(point['attempted_boundary'],'sdk-deployment');self.assertEqual(point['worker']['attempted_boundary'],'sdk-worker-deploy-left');self.assertEqual(point['worker']['error_class'],'TypeError');self.assertEqual(point['worker']['error_code'],'EACCES');self.assertEqual(point['worker']['driver_frames'],[{'line':1,'column':1}])
   self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn('AUTH_TOKEN',json.dumps(value));self.assertLess(len(json.dumps(value)),32768)
   self.assertFalse(value['native_or_performance_credit'])
 def test_unknown_metadata_fields_values_nested_objects_and_bad_Source_coordinates_refuse(self):
  original=self.diagnostic();cases=[]
  for key,value in [('PRIVATE','secret'),('error_class','PRIVATE_CLASS'),('error_code','PRIVATE_CODE'),('attempted_boundary','PRIVATE_STAGE'),('driver_frames',[{'line':1,'column':1,'path':'PRIVATE'}]),('driver_frames',[{'line':1000000,'column':1}]),('driver_frames',[{'line':1,'column':1000000}]),('driver_frames',[{'line':True,'column':1}]),('driver_frames',[{'line':1,'column':1}]*9),('worker',{'attempted_boundary':'PRIVATE'})]:
   row=copy.deepcopy(original);row[key]=value;cases.append(row)
  child=copy.deepcopy(original);child['worker']['attempted_boundary']='node-launch';cases.append(child)
  for row in cases:
   with self.subTest(rowkey=list(row)):
    self.assertEqual(m.source_bound_caught_error(row,self.source()),{'status':'refused'})
 def test_missing_metadata_is_honest_and_duplicate_Source_catalog_is_not_authority(self):
  self.assertEqual(m.source_bound_caught_error(None,self.source()),{'status':'not-recorded'})
  self.assertEqual(m.source_bound_caught_error(self.diagnostic(),self.source()+self.source()),{'status':'refused'})
  self.assertEqual(m.source_bound_caught_error(self.diagnostic(),''),{'status':'refused'})
 def test_actual_driver_Source_hash_mismatch_prevents_any_caught_error_classification(self):
  with tempfile.TemporaryDirectory()as directory:
   repo=pathlib.Path(directory).resolve();source=repo/'zig/integration/aleo_process.ts';source.parent.mkdir(parents=True);source.write_text(self.source());row=m.pin(source);source.write_text(self.source()+'\nchanged')
   result=m.driver_failure_observation({'passed':False,'errors':['PRIVATE'],'evidence':{'caughtErrorDiagnostic':self.diagnostic()}},repo,[row]);self.assertEqual(result,{'status':'source-refused'})

class EncryptedDriverFailureProjection(unittest.TestCase):
 source=DriverCaughtErrorProjection.source
 diagnostic=DriverCaughtErrorProjection.diagnostic
 def cipher(self):
  ids=re.findall(r"export const ALEO_DIAGNOSTIC_KEY_ID\s*=\s*'([0-9a-f]{32})'\s*\+\s*'([0-9a-f]{32})';",self.source());self.assertEqual(len(ids),1)
  cipher=bytes(range(256))*2
  return {'schema':1,'status':'ENCRYPTED_PREFIX','key_id':''.join(ids[0]),'prefix_bytes':85,'truncated':False,'ciphertext_base64':base64.b64encode(cipher).decode('ascii'),'ciphertext_sha256':hashlib.sha256(cipher).hexdigest()}
 def test_ciphertext_is_retained_by_actual_public_driver_writer_without_primary_or_plaintext_change(self):
  with tempfile.TemporaryDirectory()as directory:
   root=pathlib.Path(directory).resolve();repo=root/'repo';source=repo/'zig/integration/aleo_process.ts';source.parent.mkdir(parents=True);source.write_text(self.source())
   for name in ['case_delegate.py','case_supervisor.py','inner.py']:
    target=repo/'zig/tools/aleo_linux_case'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((REPO/'zig/tools/aleo_linux_case'/name).read_bytes())
   case=root/'case';driver=case/'data/case/result.json';driver.parent.mkdir(parents=True);diagnostic=self.diagnostic();baseline={'passed':False,'stage':'actual-runtime-preflight','errors':['PRIVATE_PRIMARY'],'evidence':{'caughtErrorDiagnostic':diagnostic}}
   before=m.driver_failure_observation(baseline,repo,[m.pin(source)]);record=self.cipher();diagnostic['encrypted_sdk_error']=record;driver.write_text(json.dumps(baseline));public=m.case_failure_diagnostics(case,repo,[m.pin(source)]);after=public['records']['driver']['driver_observation'];self.assertEqual(after['caught_error']['encrypted_sdk_error'],record)
   reduced=copy.deepcopy(after);del reduced['caught_error']['encrypted_sdk_error'];self.assertEqual(reduced,before);self.assertNotIn('PRIVATE',json.dumps(public));self.assertFalse(public['native_or_performance_credit'])
 def test_malformed_optional_cipher_is_unavailable_but_original_caught_fields_survive(self):
  record=self.cipher();alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';noncanonical=record['ciphertext_base64'][:-2]+alphabet[alphabet.index(record['ciphertext_base64'][-2])+1]+'=';cases=[None,{},dict(record,PRIVATE='PRIVATE_VALUE'),dict(record,ciphertext_base64=noncanonical)]
  for key,value in [('schema',True),('status','PRIVATE'),('key_id','0'*64),('prefix_bytes',True),('prefix_bytes',-1),('prefix_bytes',433),('truncated',1),('ciphertext_base64','A'*684),('ciphertext_base64',record['ciphertext_base64'][:-1]+'A'),('ciphertext_sha256','0'*64),('ciphertext_sha256','PRIVATE')]:cases.append(dict(record,**{key:value}))
  for value in cases:
   with self.subTest(optional_type=type(value).__name__):
    diagnostic=self.diagnostic();diagnostic['encrypted_sdk_error']=value;point=m.source_bound_caught_error(diagnostic,self.source());self.assertEqual(point['status'],'observed');self.assertEqual(point['worker'],self.diagnostic()['worker']);self.assertEqual(point['encrypted_sdk_error'],{'schema':1,'status':'ENCRYPTION_UNAVAILABLE'});self.assertNotIn('PRIVATE',json.dumps(point))
 def test_zero_maximum_prefix_source_key_binding_and_absent_optional_shape(self):
  for length in [0,384,404,432]:
   row=dict(self.cipher(),prefix_bytes=length,truncated=True);self.assertEqual(m.source_bound_encrypted_error(row,self.source()),row)
  row=self.cipher();self.assertEqual(m.source_bound_encrypted_error(row,self.source()+self.source()),{'schema':1,'status':'ENCRYPTION_UNAVAILABLE'})
  self.assertEqual(m.source_bound_encrypted_error({'schema':1,'status':'ENCRYPTION_UNAVAILABLE'},self.source()),{'schema':1,'status':'ENCRYPTION_UNAVAILABLE'})
  self.assertNotIn('encrypted_sdk_error',m.source_bound_caught_error(self.diagnostic(),self.source()))


class AleoRunnerBwrapPolicyControls(unittest.TestCase):
 def workflow(self):return (REPO/'.github/workflows/zig-agents.yml').read_text()
 def block(self,text,name,following):return name+text.split(name,1)[1].split(following,1)[0]
 def test_enabled_Aleo_runner_reuses_exact_restrictive_distro_setup_before_kernel(self):
  text=self.workflow();job=text.split('\n  aleo-full-case:',1)[1].split('  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0]
  name='      - name: Load distro bwrap user namespace policy for Aleo\n';following='      - name: Exact transport, both interops, fresh SDK/Docker/kernel and dedicated case\n'
  actual=self.block(text,name,following)
  expected=self.block(text,'      - name: Load distro bwrap user namespace policy\n','      - name: Check prerequisite owner controls\n')
  expected=expected.replace('      - name: Load distro bwrap user namespace policy\n',name,1).replace('        timeout-minutes: 2\n',"        if: steps.authority.outputs.enabled == 'true'\n        timeout-minutes: 2\n",1).replace("print('SVM_BWRAP_POLICY '","print('ALEO_BWRAP_POLICY '",1)
  self.assertEqual(actual,expected);self.assertEqual(job.count(name),1)
  self.assertLess(job.index('Provision ordinary host tools'),job.index(name));self.assertLess(job.index(name),job.index(following))
  self.assertIn("        if: steps.authority.outputs.enabled == 'true'\n",actual)
  self.assertIn('apparmor=4.0.1really4.0.1-0ubuntu0.24.04.9 apparmor-profiles=4.0.1really4.0.1-0ubuntu0.24.04.9',job)
  self.assertNotIn('sysctl -w',actual);self.assertNotIn('flags=(unconfined)',actual)
 def test_golden_inverse_refuses_policy_authority_and_package_drift(self):
  text=self.workflow()
  for old,new in [("print('ALEO_BWRAP_POLICY '","print('FOREIGN '") , ("        if: steps.authority.outputs.enabled == 'true'\n        timeout-minutes: 2\n",'        timeout-minutes: 2\n'),('sudo apt-get install -y --no-install-recommends apparmor=','sudo apt-get install -y --no-install-recommends foreign=')]:
   with self.subTest(old=old):
    changed=text.replace(old,new,1);self.assertNotEqual(changed,text)
    with self.assertRaises(AssertionError):ordinary_native_http_workflow(changed)



class DriverSdkDispatchProjection(unittest.TestCase):
 def source(self):return (REPO/'zig/integration/aleo_process.ts').read_text()
 def diagnostic(self):return DriverCaughtErrorProjection.diagnostic(self)
 def observed(self):
  def labels(name):
   source=self.source();body=re.findall(r'export const '+name+r':\s*readonly string\[\]\s*=\s*Object\.freeze\(\[(.*?)\]\);',source,re.S)[0];return re.findall(r"'([A-Za-z0-9_-]+)'",body)
  return {'schema':1,'kind':'aleo-existing-SDK-dispatch-observation-v1','unavailable':False,'bounded':False,'stages':[{'stage':name,'counts':{'entered':1,'returned':0,'failed':1}}for name in labels('ALEO_SDK_OBSERVATION_STAGES')],'warnings':[{'kind':name,'count':0}for name in labels('ALEO_SDK_WARNING_KINDS')],'programs':[{'role':name,'source_sha256':'a'*64,'source_bytes':10,'source_changed':False,'edition':0,'amendment':0,'edition_changed':False,'fetched':1,'added':1,'add_failed':0,'builder_contains':True}for name in labels('ALEO_SDK_PROGRAM_ROLES')],'observed_height':18,'effective_consensus':17}
 def test_existing_SDK_closed_observation_and_worker_failure_projection(self):
  value=self.observed();point=self.diagnostic();point['sdk_dispatch']=value
  result=m.source_bound_caught_error(point,self.source());self.assertEqual(result['status'],'observed');self.assertEqual(result['sdk_dispatch']['programs'],value['programs']);self.assertEqual(result['worker'],point['worker']);self.assertNotIn('PRIVATE',json.dumps(result))
  with tempfile.TemporaryDirectory()as directory:
   root=pathlib.Path(directory).resolve();repo=root/'repo';source=repo/'zig/integration/aleo_process.ts';source.parent.mkdir(parents=True);source.write_text(self.source())
   for name in ['case_delegate.py','case_supervisor.py','inner.py']:
    target=repo/'zig/tools/aleo_linux_case'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((pathlib.Path(__file__).resolve().parents[3]/'zig/tools/aleo_linux_case'/name).read_bytes())
   case=root/'case';driver=case/'data/case/result.json';driver.parent.mkdir(parents=True);driver.write_text(json.dumps({'passed':False,'stage':'actual-runtime-preflight','errors':['PRIVATE_PRIMARY'],'evidence':{'caughtErrorDiagnostic':point}}))
   result=m.case_failure_diagnostics(case,repo,[m.pin(source)]);public=result['records']['driver']['driver_observation']['caught_error'];self.assertEqual(public['sdk_dispatch']['status'],'observed');self.assertNotIn('PRIVATE',json.dumps(result))
 def test_malformed_private_unknown_overflow_wrong_hash_and_edition_refuse(self):
  original=self.observed()
  changes=[lambda x:x.update(raw='PRIVATE'),lambda x:x.update(observed_height=True),lambda x:x['programs'][0].update(role='PRIVATE'),lambda x:x['programs'][0].update(edition=65536),lambda x:x['programs'][0].update(source_sha256='PRIVATE'),lambda x:x['programs'][0].update(source_bytes=None),lambda x:x['warnings'][0].update(count=1025),lambda x:x['stages'][0]['counts'].update(entered=True)]
  for change in changes:
   v=copy.deepcopy(original);change(v)
   with self.subTest(change=changes.index(change)):self.assertEqual(m.source_bound_sdk_dispatch(v,self.source()),{'status':'refused'})
  self.assertEqual(m.source_bound_sdk_dispatch(original,self.source()+self.source()),{'status':'refused'})
 def test_optional_unavailable_and_missing_height_never_invent_edition_or_admission(self):
  v=self.observed();v.update(unavailable=True,bounded=True,observed_height=None,effective_consensus=None)
  for row in v['programs']:row.update(source_sha256=None,source_bytes=None,edition=None,amendment=None,builder_contains=None,fetched=0,added=0,add_failed=0)
  self.assertEqual(m.source_bound_sdk_dispatch(v,self.source())['status'],'observed')
  point=self.diagnostic();point['sdk_dispatch']={'PRIVATE':'PRIVATE'};result=m.source_bound_caught_error(point,self.source());self.assertEqual(result['status'],'observed');self.assertEqual(result['sdk_dispatch'],{'status':'refused'});self.assertEqual(result['worker'],point['worker'])

class NamespacePolicyDenials(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve();self.repo=self.root/'repo';self.source=self.repo/'zig/tools/aleo_linux_case/bootstrap.mjs';self.source.parent.mkdir(parents=True);self.source.write_bytes((HERE/'bootstrap.mjs').read_bytes());self.sources=[m.pin(self.source)];self.case=self.root/'case';self.errors=self.case/'control/errors';self.errors.mkdir(parents=True);self.counter=0
  for name in ('case_delegate.py','case_supervisor.py','inner.py'):(self.source.parent/name).write_bytes((HERE/name).read_bytes())
 def record(self,error,timestamp='10',legacy=False):
  self.counter+=1;value={'pid':self.counter,'threadId':0,'error':error}
  if not legacy:value['monotonic_ns']=timestamp
  path=self.errors/(str(self.counter)+'-0-'+format(self.counter,'016x')+'.json');path.write_text(json.dumps(value));return path
 def observe(self):return m.namespace_policy_failure_observation(self.case,self.repo,self.sources)
 def test_static_dynamic_unknown_and_legacy_codes_never_export_private_values(self):
  self.record('raw socket escape',legacy=True);self.record('foreign transport:https://PRIVATE_TOKEN.invalid/SECRET',legacy=True);self.record('unapproved process API:spawnSync',legacy=True);self.record('unapproved process API:PRIVATE_TOKEN',legacy=True)
  out=self.observe();self.assertEqual(out['status'],'observed');self.assertEqual(out['count'],4);self.assertEqual({r['code']for r in out['counts']},{'RAW_SOCKET_ESCAPE','FOREIGN_TRANSPORT','UNAPPROVED_PROCESS_API_SPAWNSYNC','UNRECOGNIZED'});self.assertEqual(out['order']['status'],'unavailable');wire=json.dumps(out)
  for forbidden in ['PRIVATE_TOKEN','SECRET',str(self.root),'https://','"pid"','"threadId"','monotonic_ns']:self.assertNotIn(forbidden,wire)
  self.assertFalse(out['cause_or_acceptance_authority']);self.assertFalse(out['raw_errors_paths_identities_timestamps_exported'])
 def test_only_numeric_observations_order_not_filenames_or_directory_and_ties_ambiguous(self):
  self.record('raw socket escape','30');self.record('DNS escape','10');self.record('raw TLS forbidden','10');out=self.observe();groups=out['order']['groups'];self.assertEqual(groups[0],{'codes':['DNS_ESCAPE','RAW_TLS_FORBIDDEN'],'count':2,'tie_ambiguous':True});self.assertEqual(groups[1]['codes'],['RAW_SOCKET_ESCAPE']);self.assertEqual(out['order']['status'],'observed-untrusted-monotonic-values');self.assertTrue(out['order']['not_filename_or_directory_chronology'])
  self.record('raw TLS forbidden',legacy=True);self.assertEqual(self.observe()['order']['status'],'unavailable');self.assertEqual(self.observe()['order']['groups'],[])
 def test_malformed_timestamps_keys_JSON_and_identity_refuse_without_raw_fallback(self):
  path=self.record('raw socket escape');original=json.loads(path.read_text())
  for timestamp in [None,True,4,1.5,'0','-1',' 10','1e2','١٠',str(2**64)]:
   with self.subTest(timestamp=timestamp):path.write_text(json.dumps({**original,'monotonic_ns':timestamp}));self.assertEqual(self.observe(),{'status':'unavailable'})
  for update in [{'pid':True},{'threadId':1},{'error':['PRIVATE']},{'PRIVATE':'TOKEN'}]:
   path.write_text(json.dumps({**original,**update}));self.assertEqual(self.observe(),{'status':'unavailable'})
  path.write_text('{"pid":1,"pid":1,"threadId":0,"error":"PRIVATE"}');self.assertEqual(self.observe(),{'status':'unavailable'})
 def test_regular_nofollow_directory_count_and_per_record_caps(self):
  path=self.record('raw socket escape');saved=path.read_bytes();target=self.root/'PRIVATE';target.write_bytes(saved);path.unlink();path.symlink_to(target);self.assertEqual(self.observe(),{'status':'unavailable'});path.unlink();path.write_bytes(b'X'*2049);self.assertEqual(self.observe(),{'status':'unavailable'});path.unlink()
  for _ in range(129):self.record('raw socket escape')
  opened=[];real=m.os.open
  def tracked(path,*args,**kwargs):opened.append(str(path));return real(path,*args,**kwargs)
  with mock.patch.object(m.os,'open',side_effect=tracked):self.assertEqual(self.observe(),{'status':'unavailable'})
  self.assertFalse(any(name.endswith('.json')for name in opened))
  for item in self.errors.iterdir():item.unlink()
  self.errors.rmdir();self.errors.symlink_to(target.parent,target_is_directory=True);self.assertEqual(self.observe(),{'status':'unavailable'})
 def test_source_admission_poison_and_exact_old_writer_timestamp_inverse(self):
  self.record('DNS escape');self.assertEqual(self.observe()['status'],'observed');old=list(self.sources)
  for rows in [None,old*2,[{**old[0],'sha256':'0'*64}]]:
   with mock.patch.object(m.os,'listdir',side_effect=AssertionError('no records before Source')):self.assertEqual(m.namespace_policy_failure_observation(self.case,self.repo,rows),{'status':'unavailable'})
  source=self.source.read_text();old_source=source.replace('error:message,monotonic_ns:String(process.hrtime.bigint())','error:message');self.assertNotEqual(source,old_source);self.source.write_text(old_source);self.sources=[m.pin(self.source)];self.assertEqual(self.observe()['status'],'observed')
  self.source.write_text(source.replace("deny('DNS escape')","deny('NEW PRIVATE GUARD')"));self.sources=[m.pin(self.source)];self.assertEqual(self.observe(),{'status':'unavailable'})
 def test_failure_only_public_caller_and_output_groups_bounded(self):
  self.record('DNS escape');(self.case/'control/inner-result.json').write_text(json.dumps({'passed':False,'error':'ValueError:latched all-isolate policy violation'}));out=m.case_failure_diagnostics(self.case,self.repo,self.sources);self.assertEqual(out['records']['namespace']['policy_denials']['status'],'observed')
  (self.case/'control/inner-result.json').write_text('{"passed":true}')
  with mock.patch.object(m,'namespace_policy_failure_observation',side_effect=AssertionError('not failure')):self.assertNotIn('policy_denials',m.case_failure_diagnostics(self.case,self.repo,self.sources)['records']['namespace'])
  for item in self.errors.iterdir():item.unlink()
  for i in range(128):self.record('DNS escape',str(i+1))
  out=self.observe();self.assertEqual(out['count'],128);self.assertTrue(out['order']['groups_truncated']);self.assertEqual(len(out['order']['groups']),16);self.assertLessEqual(len(json.dumps(out).encode()),8192)

class ForeignTransportClassifications(unittest.TestCase):
 record=NamespacePolicyDenials.record
 observe=NamespacePolicyDenials.observe
 def setUp(self):
  NamespacePolicyDenials.setUp(self)
  for name in ('case_specs.py','closed-cache-assets.json.gz'):
   path=self.source.parent/name;path.write_bytes((HERE/name).read_bytes());self.sources.append(m.pin(path))
 def classification(self,error):
  for path in self.errors.iterdir():path.unlink()
  self.record(error);out=self.observe();self.assertEqual(out['status'],'observed');return out['foreign_transport']
 def test_admitted_origin_path_is_not_exact_href_or_method_and_no_private_values(self):
  import gzip
  grant=json.loads(gzip.decompress((self.source.parent/'closed-cache-assets.json.gz').read_bytes()));url=grant['assets'][0]['url'];out=self.classification('foreign transport:'+url);row=out['classes'][0]
  self.assertEqual(row['protocol'],'HTTPS');self.assertEqual(row['asset_relation'],'SOURCE_ASSET_ORIGIN_AND_PATH')
  for field in ('method_observed','query_observed','caller_observed','exact_asset_href_observed'):self.assertFalse(out[field])
  out=self.classification('foreign transport:https://PRIVATE_TOKEN.invalid/SECRET/private/path');wire=json.dumps(out)
  for value in ('PRIVATE_TOKEN','SECRET','private/path','https://','sha256','hostname'):self.assertNotIn(value,wire)
  self.assertEqual(out['classes'][0]['host_class'],'OTHER');self.assertFalse(out['cause_or_acceptance_authority'])
 def test_fixed_loopback_alias_protocol_and_Source_port_classes(self):
  for url,protocol,host,port in [('http://127.0.0.1:23030/testnet/program/public_fixture.aleo','HTTP','EXACT_IPV4_LOOPBACK','SOURCE_RPC'),('https://127.0.0.1:23030/testnet/block/1','HTTPS','EXACT_IPV4_LOOPBACK','SOURCE_RPC'),('http://localhost:23033/testnet/statePath/public_fixture','HTTP','LOCALHOST_ALIAS','SOURCE_OTHER_POLICY_PORT'),('http://[::1]:23032/','HTTP','IPV6_LOOPBACK','SOURCE_CACHE'),('http://127.0.0.1:12345/','HTTP','EXACT_IPV4_LOOPBACK','OTHER'),('file:///synthetic','FILE','ABSENT','UNSTATED')]:
   row=self.classification('foreign transport:'+url)['classes'][0];self.assertEqual((row['protocol'],row['host_class'],row['port_class']),(protocol,host,port))
 def test_opaque_truncated_malformed_and_non_Source_shape_are_unavailable(self):
  for suffix in ('mailto://user@PRIVATE.invalid','javascript://PRIVATE','https://','http://[::1','http://host:99999/path','http://host:bad/path','https://host/path?PRIVATE','https://host/path#PRIVATE','https://host/\nPRIVATE'):
   with self.subTest(suffix=suffix):self.assertEqual(self.classification('foreign transport:'+suffix),{'status':'unavailable'})
 def test_required_Source_pins_ports_alias_metadata_and_gzip_bounds_fail_closed(self):
  self.record('foreign transport:https://unlisted.invalid/path');saved=list(self.sources)
  for values in [saved[:1],saved+[saved[-1]],[{**r,'sha256':'0'*64}if r==saved[-1]else r for r in saved]]:
   self.sources=values;out=self.observe();self.assertEqual(out['status'],'observed');self.assertEqual(out['foreign_transport'],{'status':'unavailable'})
  self.sources=saved;source=self.source.parent/'case_specs.py';original=source.read_bytes();source.write_bytes(original.replace(b"'rpc_ports':[23030",b"'rpc_ports':[True",1));self.sources=[m.pin(pathlib.Path(r['path']))for r in saved];self.assertEqual(self.observe()['foreign_transport'],{'status':'unavailable'});source.write_bytes(original)
  import gzip
  source=self.source.parent/'closed-cache-assets.json.gz';source.write_bytes(gzip.compress(b'x'*(256*1024+1)));self.sources=[m.pin(pathlib.Path(r['path']))for r in saved];self.assertEqual(self.observe()['foreign_transport'],{'status':'unavailable'})
 def test_classes_aggregate_and_truncate_without_identities_or_order_and_keep_old_bound(self):
  for host in ('127.0.0.1','localhost','[::1]','unlisted.invalid'):
   for port in (23030,23032,23033,12345):self.record('foreign transport:http://'+host+':'+str(port)+'/testnet/block/1')
  out=self.observe();self.assertEqual(out['count'],16);value=out['foreign_transport'];self.assertEqual(value['classified_count'],16);self.assertEqual(len(value['classes']),8);self.assertTrue(value['classes_truncated']);self.assertLessEqual(len(json.dumps(out).encode()),8192)
 def test_real_old_projection_near_8192_omits_optional_field_instead_of_losing_counts(self):
  wire=pathlib.Path(m.__file__).read_text();tree=ast.parse(wire);fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='namespace_policy_failure_observation');legacy=ast.get_source_segment(wire,fn)
  for before,after in [(";foreign=[]",""),(";foreign.append(error)","")]:
   self.assertEqual(legacy.count(before),1);legacy=legacy.replace(before,after,1)
  marker='  if foreign:\n';tail="  need(len(json.dumps(result).encode())<=8192,'closed denial projection cap');return result";self.assertEqual(legacy.count(marker),1);start=legacy.index(marker);end=legacy.index(tail,start);legacy=legacy[:start]+legacy[end:]
  expected=('30c00da7b41e427b1d7383580dd9c579' '3a1448339f9b7ffa1b990c2c84fe92a2');self.assertEqual(hashlib.sha256(legacy.encode()).hexdigest(),expected)
  space=dict(m.__dict__);exec(compile(ast.parse(legacy),'<exact-current-Source-inverse>','exec'),space)
  self.record('DNS escape');self.record('foreign transport:https://unlisted.invalid/path');original=self.source.read_text();low=0;high=3000
  def old(count):
   self.source.write_text(original+'\n'+"deny('DNS escape');\n"*count);self.sources=[m.pin(pathlib.Path(row['path']))for row in self.sources];return space['namespace_policy_failure_observation'](self.case,self.repo,self.sources)
  while low+1<high:
   mid=(low+high)//2;value=old(mid)
   if value.get('status')=='observed':low=mid
   else:high=mid
  expected=old(low);self.assertEqual(expected['status'],'observed');self.assertLessEqual(len(json.dumps(expected).encode()),8192);self.assertGreater(len(json.dumps({**expected,'foreign_transport':{'status':'unavailable'}}).encode()),8192)
  with mock.patch.object(m,'namespace_foreign_transport_observation',return_value={'status':'unavailable'}):out=self.observe()
  self.assertEqual(out,expected);self.assertNotIn('foreign_transport',out)
 def test_optional_helper_BaseException_or_serialization_failure_preserves_original_counts(self):
  self.record('foreign transport:https://unlisted.invalid/path');normal=self.observe();expected={k:v for k,v in normal.items()if k!='foreign_transport'}
  for options in ({'side_effect':KeyboardInterrupt()},{'return_value':{'status':object()}}):
   with mock.patch.object(m,'namespace_foreign_transport_observation',**options):out=self.observe()
   self.assertEqual(out['foreign_transport'],{'status':'unavailable'});self.assertEqual({k:v for k,v in out.items()if k!='foreign_transport'},expected)
  for path in self.errors.iterdir():path.unlink()
  self.record('DNS escape')
  with mock.patch.object(m,'namespace_foreign_transport_observation',side_effect=AssertionError('not foreign')):self.assertNotIn('foreign_transport',self.observe())

 def test_srs_exact_Source_filename_variant_and_sdk_checksum_never_inferred(self):
  import gzip
  grant=json.loads(gzip.decompress((self.source.parent/'closed-cache-assets.json.gz').read_bytes()));asset=next(r['url']for r in grant['assets']if '/powers-of-beta-18.usrs.'in r['url']);filename=asset.rsplit('/',1)[-1]
  variants=[(asset,'SOURCE_ASSET_VERSION_TAG_MATCH','HEX7'),('https://parameters.provable.com/mainnet.parameters/'+filename,'SOURCE_ASSET_VERSION_TAG_MATCH','HEX7'),(asset.rsplit('.',1)[0]+'.0000000','SOURCE_ASSET_VERSION_TAG_DIFFERENT','HEX7'),(asset.rsplit('.',1)[0],'UNAVAILABLE','ABSENT'),(asset.rsplit('.',1)[0]+'.'+'a'*64,'UNAVAILABLE','HEX64')]
  for url,relation,shape in variants:
   row=self.classification('foreign transport:'+url)['classes'][0];self.assertIn('srs_filename',row);value=row['srs_filename'];self.assertEqual(value,{'status':'observed','degree':18,'shifted':False,'suffix_shape':shape,'filename_metadata_relation':relation})
   wire=json.dumps(row);self.assertNotIn(filename,wire);self.assertNotIn(asset,wire);self.assertNotIn('a'*64,wire)
 def test_srs_all_Source_known_degrees_shifted_and_unknown_metadata(self):
  for degree in range(15,26):
   for shifted in [False,True]:
    url='https://parameters.provable.com/mainnet/'+('shifted-'if shifted else'')+'powers-of-beta-'+str(degree)+'.usrs.0000000';row=self.classification('foreign transport:'+url)['classes'][0];self.assertIn('srs_filename',row);value=row['srs_filename'];self.assertEqual((value['degree'],value['shifted']),(degree,shifted));self.assertEqual(value['filename_metadata_relation'],'SOURCE_ASSET_VERSION_TAG_DIFFERENT'if degree<=19 else'NO_ADMITTED_SOURCE_METADATA');self.assertNotIn('SDK_checksum_match',value)
  for filename in ('powers-of-beta-14.usrs.0000000','powers-of-beta-26.usrs.0000000','powers-of-beta-019.usrs.0000000','powers-of-beta-19.usrs.PRIVATE_TAG'):
   out=self.classification('foreign transport:https://parameters.provable.com/mainnet/'+filename);row=out['classes'][0];self.assertIn('srs_filename',row)
   if 'PRIVATE'in filename:
    self.assertEqual(row['srs_filename']['suffix_shape'],'OTHER');self.assertNotIn('PRIVATE_TAG',json.dumps(out))
   else:self.assertEqual(row['srs_filename'],{'status':'unavailable'})
 def test_both_degree19_variants_are_Source_metadata_only_without_exact_request_credit(self):
  known='https://parameters.provable.com/mainnet/powers-of-beta-19.usrs.e535d44';row=self.classification('foreign transport:'+known)['classes'][0]
  self.assertEqual(row['asset_relation'],'SOURCE_ASSET_ORIGIN_AND_PATH');self.assertEqual(row['srs_filename'],{'status':'observed','degree':19,'shifted':False,'suffix_shape':'HEX7','filename_metadata_relation':'SOURCE_ASSET_VERSION_TAG_MATCH'})
  shifted='https://parameters.provable.com/mainnet/shifted-powers-of-beta-19.usrs.662e343';row=self.classification('foreign transport:'+shifted)['classes'][0]
  self.assertEqual(row['asset_relation'],'SOURCE_ASSET_ORIGIN_AND_PATH');self.assertEqual(row['srs_filename']['filename_metadata_relation'],'SOURCE_ASSET_VERSION_TAG_MATCH');self.assertFalse(self.classification('foreign transport:'+known)['exact_asset_href_observed'])

 def test_srs_aggregation_bound_and_optional_field_preserves_old_counts(self):
  for degree in range(15,26):self.record('foreign transport:https://parameters.provable.com/mainnet/powers-of-beta-'+str(degree)+'.usrs.0000000')
  out=self.observe();self.assertEqual(out['count'],11);classification=out['foreign_transport'];self.assertEqual(classification['classified_count'],11);self.assertEqual(len(classification['classes']),8);self.assertTrue(classification['classes_truncated']);self.assertLessEqual(len(json.dumps(out).encode()),8192)
  before={k:v for k,v in out.items()if k!='foreign_transport'}
  with mock.patch.object(m,'namespace_foreign_transport_observation',side_effect=KeyboardInterrupt):after=self.observe()
  self.assertEqual({k:v for k,v in after.items()if k!='foreign_transport'},before);self.assertEqual(after['foreign_transport'],{'status':'unavailable'})


if __name__=='__main__':unittest.main(verbosity=2)
