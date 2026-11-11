"""Pure Source/schema/archive controls. No fixture main/native/process/network."""
from pathlib import Path
import ast,copy,hashlib,importlib.util,io,itertools,json,os,re,selectors,stat,struct,sys,tempfile,unittest,warnings,zipfile
from types import SimpleNamespace as N
from unittest import mock
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
import paired_linux as p
import paired_linux_stage as stage
import paired_linux_proofs as proof
ROOT=Path(os.environ.get('PAIRED_CONTROL_REPO',str(HERE.parents[1]))).resolve()
def load(path,name):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
reader=load(ROOT/'zig/bench/cohort_readback.py','paired_control_archive')
def ordinary_native_http_workflow(text):
 # Exact inverse of the two reviewed functional diagnostic-only uploads.
 functional_diagnostics_after = '            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/functional-result.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/functional-failure.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/worker.log\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/actual-agent-launches.json\n'
 functional_diagnostics_before = '            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/functional-result.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/actual-agent-launches.json\n'
 if text.count(functional_diagnostics_after) != 1: raise AssertionError('Exact functional diagnostic uploads required')
 text = text.replace(functional_diagnostics_after, functional_diagnostics_before, 1)
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

class Controls(unittest.TestCase):
 def test_worker_environment_uses_actual_native_consumer_key(self):
  source=(ROOT/'zig/src/aleo/worker.zig').read_text()
  self.assertIn('getEnvVarOwned(a, "'+p.ENV['worker']+'")',source)
  self.assertEqual(p.env_for({'artifacts':{'zig':{'ReleaseSafe':{'worker':{'path':'bin/worker'},**{n:{'path':'lib/'+n}for n in p.ENV if n!='worker'}}}}},self.root,'ReleaseSafe')['HYPERLANE_ALEO_VM_WORKER'],str(self.root/'bin/worker'))
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir()
 def inert_request(self):
  # Explicit control fixture, independent of the live request approval state.
  return {'schema':1,'kind':'paired-linux-ci-v1','root_approved':False,'inputs_enabled':False,'functional_enabled':False,'runtime_enabled':False,'handoff_enabled':False,'handoff_postgres_source':None,'handoff_reuse_source':None,'handoff_port8_source':None,'producer_source_commit':'b'*40,'baseline_source_commit':p.BASELINE,'baseline_profile':'locked-c520224-production-three-agent-linux-v1','qualified_cohort':None,'transport_requests':{mode:None for mode in p.MODES},'required_source':None,'prepared_inputs':None,'accepted_six':None,'runtime_authority':None}
 def test_false_gate_has_no_source_import_or_artifact_access(self):
  path=self.root/'request.json';path.write_text(json.dumps(self.inert_request()))
  with mock.patch.object(p,'checked',side_effect=AssertionError('artifact admission reached')),mock.patch.object(p,'load_source',side_effect=AssertionError('Source import reached')):
   value,row=p.request(path,p.pin(path)['sha256'],self.repo)
   self.assertFalse(value['root_approved']);self.assertFalse(any(value[k]for k in ['inputs_enabled','functional_enabled','runtime_enabled']))
 def approved(self,producer='b'*40):
  # Real canonical dispatcher Source and actual encoded transport/header shape;
  # only the Root-curated qualification and finite checkout file bytes are
  # controlled fixtures. No downloader, custody or executable runs here.
  for name in p.SOURCE_PATHS:
   target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((ROOT/name).read_bytes()if name=='zig/bench/native_case_ci.py'else b'# controlled public Source\n')
  cohort=p.decode((ROOT/'zig/tools/aleo_linux_case/cohort-qualification.PENDING.json').read_bytes());cohort['source_commit']=producer;cohort['eight_artifacts']['tools']['name']='zig-native-case-tools-'+producer;cohort['eight_artifacts']['radix_reference']['name']='zig-native-radix-reference-'+producer
  cohort_path=self.repo/'qualified.json';cohort_path.write_text(json.dumps(cohort));value=self.inert_request();value.update(root_approved=True,inputs_enabled=True,functional_enabled=True,producer_source_commit=producer,required_source=[{**p.pin(self.repo/name),'path':name}for name in sorted(p.SOURCE_PATHS)],qualified_cohort={**p.pin(cohort_path),'path':'qualified.json'})
  for mode in p.MODES:
   raw=json.loads((ROOT/f'zig/tools/aleo_linux_case/transport-{mode}.PENDING.json').read_text());raw['root_approved']=True;raw['producer_source_commit']=producer;raw['artifact_pins']['tools']['name']='zig-native-case-tools-'+producer;path=self.repo/(mode+'.json');path.write_text(json.dumps(raw));value['transport_requests'][mode]={**p.pin(path),'path':path.name}
  path=self.repo/'request.json';path.write_text(json.dumps(value));return path,value
 def test_actual_approved_request_loads_four_argument_dispatcher_and_future_cohort(self):
  path,value=self.approved();result,row=p.request(path,p.pin(path)['sha256'],self.repo);self.assertTrue(result['root_approved']);self.assertTrue(result['functional_enabled']);self.assertEqual(result['producer_source_commit'],'b'*40);self.assertEqual(row,p.pin(path))
  module=sys.modules['paired_checked_dispatch'];self.assertEqual(Path(module.__file__),self.repo/'zig/bench/native_case_ci.py');decoded=module.read_request(self.repo/'ReleaseSafe.json');self.assertIsInstance(decoded['postgres']['image_id'],str);module.validate_request(decoded)
 def test_approved_request_refuses_foreign_8_transport_Source_and_runtime_enable(self):
  path,value=self.approved()
  for mutate in [lambda v:v.update(producer_source_commit='c'*40),lambda v:v.update(runtime_enabled=True)]:
   changed=copy.deepcopy(value);mutate(changed);path.write_text(json.dumps(changed))
   with self.assertRaises(p.Refused):p.request(path,p.pin(path)['sha256'],self.repo)
  path.write_text(json.dumps(value));(self.repo/'ReleaseSafe.json').write_text('{}')
  with self.assertRaises(p.Refused):p.request(path,p.pin(path)['sha256'],self.repo)
 def test_all_internal_checked_loader_calls_match_real_function_arity(self):
  for name in ['paired_linux.py','paired_linux_owner.py','paired_linux_stage.py']:
   tree=ast.parse((HERE/name).read_text())
   for node in ast.walk(tree):
    if isinstance(node,ast.Call)and ((isinstance(node.func,ast.Name)and node.func.id=='load_source')or(isinstance(node.func,ast.Attribute)and node.func.attr=='load_source')):self.assertEqual(len(node.args),4,(name,node.lineno));self.assertFalse(node.keywords)
 def test_all_resolvable_internal_calls_bind_actual_current_signatures(self):
  modules={name:ast.parse((HERE/(name+'.py')).read_text())for name in ['paired_linux','paired_linux_owner','paired_linux_stage','paired_linux_proofs']};functions={name:{n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}for name,tree in modules.items()};aliases={'p':'paired_linux','policy':'paired_linux','stage':'paired_linux_stage','proof':'paired_linux_proofs'}
  for name,tree in modules.items():
   for node in ast.walk(tree):
    if not isinstance(node,ast.Call):continue
    fn=functions[name].get(node.func.id)if isinstance(node.func,ast.Name)else functions.get(aliases.get(node.func.value.id,''),{}).get(node.func.attr)if isinstance(node.func,ast.Attribute)and isinstance(node.func.value,ast.Name)else None
    if fn is None or any(isinstance(v,ast.Starred)for v in node.args)or any(k.arg is None for k in node.keywords):continue
    names=[v.arg for v in [*fn.args.posonlyargs,*fn.args.args]];required=set(names[:len(names)-len(fn.args.defaults)]);positional=set(names[:len(node.args)]);keywords={k.arg for k in node.keywords};where=(name,node.lineno,fn.name)
    if fn.args.vararg is None:self.assertLessEqual(len(node.args),len(names),where)
    self.assertFalse(positional&keywords,where);self.assertTrue(required<=positional|keywords,where)
    if fn.args.kwarg is None:self.assertTrue(keywords<=set(names)|{v.arg for v in fn.args.kwonlyargs},where)
 def test_false_policy_cannot_authorize_work_and_unknown_fields_refuse(self):
  base=self.inert_request()
  for key,value in [('root_approved',1),('inputs_enabled',True),('functional_enabled',True),('runtime_enabled',True),('unknown',None)]:
   v={**base,key:value};path=self.root/'request.json';path.write_text(json.dumps(v))
   with self.subTest(key=key),self.assertRaises(p.Refused):p.request(path,p.pin(path)['sha256'],self.repo)
 def test_strict_json_duplicate_nonfinite_and_nested_refuse(self):
  for raw in [b'{"x":1,"x":2}',b'{"x":NaN}',b'{"x":1e999}',b'['*34+b'0'+b']'*34]:
   with self.subTest(raw=raw[:30]),self.assertRaises(p.Refused):p.decode(raw)
  self.assertEqual(p.decode(b'{"sha256_hex_chunks":["'+b'a'*32+b'","'+b'b'*32+b'"]}'),'a'*32+'b'*32)
 def test_relative_names_refuse_source_escape_and_noncanonical(self):
  for name in ['../x','/x','a//x','a/../x','a\\x','a\0x','a\nx','a\rx','./x']:
   with self.subTest(name=name),self.assertRaises(p.Refused):p.relative(name)
 def test_source_loader_executes_captured_checked_bytes_and_refuses_mutation(self):
  path=self.repo/'module.py';path.write_text('value=7\n');r=p.pin(path);authority={'required_source':[{**r,'path':'module.py'}]}
  self.assertEqual(p.load_source(path,'paired_control_checked',authority,self.repo).value,7)
  path.write_text('value=8\n')
  with self.assertRaises(p.Refused):p.load_source(path,'paired_control_changed',authority,self.repo)
 def test_six_commands_use_exact_mode_roles_full_manifest_and_original_proof_kind(self):
  value={'producer_source_commit':'b'*40,'artifacts':{'zig':{m:{n:{'path':m+'/'+n,'sha256':str(i)*64}for i,n in enumerate(sorted(p.ZIG))}for m in p.MODES},'tools':{n:{'path':'tools/bin/'+n}for n in p.TOOLS},'tool_manifest':{'path':'tools/manifest.json','sha256':'c'*64}}}
  for index in range(6):
   mode=p.MODES[index//3];kind=p.KINDS[index%3];cmd=p.functional_command(value,self.root,self.repo,index,self.root/'out.json')
   self.assertEqual(cmd[3],str(self.repo/'zig/integration'/(kind+'.py')));self.assertEqual(cmd[cmd.index('--binary')+1],str(self.root/mode/'relayer'))
   self.assertEqual(cmd[-6:],['--tool-manifest',str(self.root/'tools/manifest.json'),'--tool-manifest-sha256','c'*64,'--tool-source-commit','b'*40]);self.assertEqual('--reference'in cmd,kind=='relayer_stream');self.assertEqual('--validator-binary'in cmd,kind!='public_relay_process')
  for index in [-1,6,True]:
   with self.assertRaises(p.Refused):p.functional_command(value,self.root,self.repo,index,self.root/'out')
 def remote(self):
  run={'id':42,'run_attempt':1,'head_sha':'b'*40,'repository':{'full_name':stage.REPO},'head_repository':{'full_name':stage.REPO},'event':'push','path':'.github/workflows/zig-agents.yml'}
  jobs=[{'name':'paired-linux-inputs','id':7,'run_id':42,'status':'completed','conclusion':'success'}];artifacts=[{'id':8,'name':'paired-linux-inputs-42-1','expired':False,'size_in_bytes':100,'digest':'sha256:'+'c'*64,'workflow_run':{'id':42,'head_sha':'b'*40}}]
  return run,jobs,artifacts
 def test_actual_completed_input_publisher_bound_to_all_identities(self):
  run,jobs,artifacts=self.remote();row=stage.identity(run,jobs,artifacts,42,1,'b'*40,'paired-linux-inputs-42-1');self.assertEqual(row['job_id'],7)
  variants=[(dict(run,head_sha='d'*40),jobs,artifacts),(dict(run,run_attempt=2),jobs,artifacts),(run,jobs*2,artifacts),(run,[dict(jobs[0],conclusion='failure')],artifacts),(run,jobs,artifacts*2),(run,jobs,[dict(artifacts[0],expired=True)]),(run,jobs,[dict(artifacts[0],workflow_run={'id':43,'head_sha':'b'*40})])]
  for args in variants:
   with self.subTest(args=args),self.assertRaises(p.Refused):stage.identity(*args,42,1,'b'*40,'paired-linux-inputs-42-1')
 def archive(self,rows):
  path=self.root/'archive.zip'
  with zipfile.ZipFile(path,'w')as z:
   for name,body,mode in rows:
    i=zipfile.ZipInfo(name);i.external_attr=mode<<16
    with warnings.catch_warnings():warnings.simplefilter('ignore',UserWarning);z.writestr(i,body)
  return path
 def test_real_zip_regular_extraction_is_data_mode_and_exact_digest(self):
  path=self.archive([('tools/bin/oracle',b'public fixture',stat.S_IFREG|0o755)]);a=reader.Archive(path,lambda count=0:None)
  try:rows=stage.extract(a,self.root/'out');self.assertEqual(rows[0]['sha256'],hashlib.sha256(b'public fixture').hexdigest());self.assertEqual((self.root/'out/tools/bin/oracle').stat().st_mode&0o777,0o600)
  finally:a.close()
 def test_malformed_zip_refuses_before_destination_creation(self):
  for rows in [[('../escape',b'x',stat.S_IFREG)],[('link',b'outside',stat.S_IFLNK|0o777)],[('p',b'x',stat.S_IFREG),('p/c',b'x',stat.S_IFREG)],[('x',b'x',stat.S_IFREG),('x',b'y',stat.S_IFREG)]]:
   with self.subTest(rows=rows),self.assertRaises(reader.Refused):reader.Archive(self.archive(rows),lambda count=0:None)
   self.assertFalse((self.root/'out').exists())
 def test_fixture_data_cannot_overwrite_source_and_existing_mismatch_refuses(self):
  source=self.root/'published';source.mkdir();f=source/'data';f.write_bytes(b'data');r={**p.pin(f),'path':'data'};valid={'repository_fixture_files':[{'repository_path':'zig/integration/.cache/contracts.json','file':r}]}
  self.assertEqual(stage.materialize(valid,source,self.repo)[0]['sha256'],r['sha256']);target=self.repo/'zig/integration/.cache/contracts.json';target.write_bytes(b'foreign')
  with self.assertRaises(p.Refused):stage.materialize(valid,source,self.repo)
  for name in ['zig/src/agents/main.zig','zig/integration/evm.py','../foreign']:
   v={'repository_fixture_files':[{'repository_path':name,'file':r}]}
   with self.assertRaises(p.Refused):stage.materialize(v,source,self.repo)
 def test_stage_clock_caps_and_no_native_execution(self):
  self.assertEqual(stage.LIMITS['wall_seconds'],1800);self.assertEqual(stage.LIMITS['host_free_bytes'],6*1024**3);self.assertEqual(stage.LIMITS['inspector_RAM_bytes'],1024**3)
  tree=ast.parse((HERE/'paired_linux_stage.py').read_text());self.assertFalse(any(isinstance(n,ast.Attribute)and n.attr in {'Popen','CDLL','dlopen'}for n in ast.walk(tree)))
 def test_consumer_cancellation_uses_actual_Runner_independent_kill_wait(self):
  self.assertTrue(issubclass(stage.TaskInterrupted,RuntimeError));self.assertFalse(issubclass(stage.TaskInterrupted,InterruptedError))
  guard=N(deadline=10,cleanup_deadline=20,clock=lambda:0)
  with mock.patch.object(stage.signal,'getitimer',return_value=(0.0,0.0)),mock.patch.object(stage.signal,'signal')as signals,mock.patch.object(stage.signal,'setitimer')as timer:
   previous=stage.arm_interrupts(guard);self.assertEqual(timer.call_args.args,(stage.signal.ITIMER_REAL,10));self.assertEqual(len(previous),4)
   work=self.root/'runner';work.mkdir();runner=reader.Runner.__new__(reader.Runner)
   runner.root=work;runner.repo=self.repo;runner.gh=Path('/fixture/gh');runner.token='private-control-token';runner.guard=N(deadline=10,cleanup_deadline=20,clock=lambda:0);runner.guard=mock.Mock(wraps=lambda count=0:None);runner.guard.deadline=10;runner.guard.cleanup_deadline=20;runner.guard.clock=lambda:0
   runner.count=runner.waited=runner.failed=0;runner.wait_hash=hashlib.sha256();runner.last_failed_command=None;runner.last_command_diagnostic=None;runner.gh_startup=None
   child=mock.Mock(pid=123);child.wait.return_value=-9
   count=[0]
   def exit_probe(*ignored):
    count[0]+=1
    if count[0]==1:stage.interrupted(stage.signal.SIGTERM,None)
    return None
   with mock.patch.object(reader.subprocess,'Popen',return_value=child),mock.patch.object(reader.os,'waitid',side_effect=exit_probe):
    with self.assertRaises(stage.TaskInterrupted):runner.call(['/fixture/gh','api','fixture'],'API_JSON',65536)
   child.kill.assert_called_once();child.wait.assert_called_once();self.assertEqual(runner.count,runner.waited);self.assertEqual(runner.failed,1);self.assertNotIn('private-control-token',json.dumps(runner.last_command_diagnostic));self.assertTrue(all(call.args[1]==stage.signal.SIG_IGN for call in signals.call_args_list[-4:]))
   with selectors.SelectSelector()as selected,mock.patch.object(selectors.SelectSelector,'_select',side_effect=lambda *ignored:stage.interrupted(stage.signal.SIGTERM,None)):
    with self.assertRaises(stage.TaskInterrupted):selected.select(0)
   stage.restore_interrupts(previous)
 def test_actual_WSS_TLS_Source_and_OpenSSL_resolution_are_required(self):
  stream=ast.parse((ROOT/'zig/integration/relayer_stream.py').read_text());self.assertTrue(any(isinstance(n,ast.Import)and any(a.name=='tls_fixture'for a in n.names)for n in stream.body));self.assertIn('zig/integration/tls_fixture.py',p.SOURCE_PATHS)
  tls=ast.parse((ROOT/'zig/integration/tls_fixture.py').read_text());calls=[n for n in ast.walk(tls)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr=='run'];self.assertEqual(len(calls),1);self.assertEqual(ast.literal_eval(calls[0].args[0].elts[0]),'openssl')
  root=self.root/'input';root.mkdir();payload=root/'public-data';payload.write_bytes(b'public fixture');row={**p.pin(payload),'path':payload.name};flags=['fixture_cpu'];groups={'rust':{n:row for n in p.RUST},'zig':{m:{n:row for n in p.ZIG}for m in p.MODES},'tools':{n:row for n in p.TOOLS},'tool_manifest':row,'evm_oracle':row}
  # Distinct producer metadata is mocked explicitly. Execute the ACTUAL consumer
  # gate through its real required-tool checks; no ELF/main or SDK runs here.
  names={'anvil','cast','clang','cc','node','pnpm','git','ps','lsof','sh','openssl'};external=p.pin(payload);value={'schema':1,'kind':'paired-linux-inputs-v1','platform':'linux-x86_64','producer_source_commit':'b'*40,'baseline_source_commit':p.BASELINE,'baseline_profile':p.LEGACY_PROFILE,'passed':True,'source_unchanged':True,'all_actual_parent_waits':True,'owned_absent':True,'artifacts':groups,'files':[row],'required_cpu_flags':flags,'external':{'tools':{n:external for n in names},'libraries':{}},'repository_fixture_files':[]};manifest=root/'input-manifest.json';manifest.write_text(json.dumps(value));original=p.Path.read_text
  def text(path,*args,**kwargs):return 'flags : fixture_cpu\n'if str(path)=='/proc/cpuinfo'else original(path,*args,**kwargs)
  with mock.patch.object(p.Path,'read_text',text),mock.patch.object(__import__('shutil'),'which',return_value=str(payload)):
   self.assertTrue(p.input_manifest(manifest,root,self.repo,'b'*40)['passed']);del value['external']['tools']['openssl'];manifest.write_text(json.dumps(value))
   with self.assertRaisesRegex(p.Refused,'fixture executable closure'):p.input_manifest(manifest,root,self.repo,'b'*40)
 def test_manifest_cannot_downgrade_the_admitted_portable_request_to_legacy_profile(self):
  root=self.root/'profile-input';root.mkdir();payload=root/'public-data';payload.write_bytes(b'public fixture');row={**p.pin(payload),'path':payload.name};flags=['fixture_cpu']
  groups={'rust':{n:row for n in p.RUST},'zig':{mode:{n:row for n in p.ZIG}for mode in p.MODES},'tools':{n:row for n in p.TOOLS},'tool_manifest':row,'evm_oracle':row}
  external=p.pin(payload);names={'anvil','cast','clang','cc','node','pnpm','git','ps','lsof','sh','openssl'}
  value={'schema':1,'kind':'paired-linux-inputs-v1','platform':'linux-x86_64','producer_source_commit':'b'*40,'baseline_source_commit':p.BASELINE,'baseline_profile':p.LEGACY_PROFILE,'passed':True,'source_unchanged':True,'all_actual_parent_waits':True,'owned_absent':True,'artifacts':groups,'files':[row],'required_cpu_flags':flags,'external':{'tools':{n:external for n in names},'libraries':{}},'repository_fixture_files':[]}
  manifest=root/'input-manifest.json';manifest.write_text(json.dumps(value));original=p.Path.read_text
  def text(path,*args,**kwargs):return 'flags : fixture_cpu\n'if str(path)=='/proc/cpuinfo'else original(path,*args,**kwargs)
  with mock.patch.object(p.Path,'read_text',text),mock.patch.object(__import__('shutil'),'which',return_value=str(payload)):
   self.assertTrue(p.input_manifest(manifest,root,self.repo,'b'*40)['passed'])
   self.assertTrue(p.input_manifest(manifest,root,self.repo,'b'*40,{'baseline_profile':p.LEGACY_PROFILE})['passed'])
   with self.assertRaisesRegex(p.Refused,'profile differs from admitted request'):p.input_manifest(manifest,root,self.repo,'b'*40,{'baseline_profile':p.PORTABLE_PROFILE})
   with self.assertRaisesRegex(p.Refused,'profile differs from admitted request'):p.input_manifest(manifest,root,self.repo,'b'*40,{'required_source':[]})

 def test_method_matrix_original_schedule_and_pair_order(self):
  value=p.decode((HERE/'paired_linux_methods.json').read_bytes());rows=value['sequence'];self.assertEqual(len(rows),10)
  for i,row in enumerate(rows):
   self.assertEqual(row['index'],i);self.assertEqual(row['pairs'],5);self.assertEqual(row['pair_orders'],[['rust','zig'],['zig','rust'],['rust','zig'],['zig','rust'],['rust','zig']]);self.assertEqual(row['argv'][row['argv'].index('--samples')+1],'5');self.assertNotIn('/private/tmp/',json.dumps(row['argv']))
  self.assertEqual([r['role']for r in rows],['validator']*4+['scraper']*2+['relayer']*4)
 def settlement(self,count):
  return {'production_confirm_seconds':600,'bounded_grace_seconds':30,'expected_tracked_messages':count,'historical_offset_is_upper_bound_not_injected_counter':True,'historical_confirmed_offset':0,'operations_confirmed':count,'first_live_completion':{'confirmed':count,'monotonic':701},'first_proxy_inclusions':[{'id_chunks':[str(i)],'first_positive_receipt_or_delivered_monotonic_seconds':100}for i in range(count)]}
 def process(self):
  crash={'passed':True,'recovery_new_nonce_count':1,'restart_new_nonce_count':0,'settlement':self.settlement(1),'recovery_stop':{'exit':0},'replay_stop':{'exit':0}}
  return {'passed':True,'binaries':{'relayer_sha256_chunks':['a'*64]},'settlement':self.settlement(3),'max_batch_4':{'settlement':self.settlement(4),'actual_allocation':{'calls':4,'members':[1,2,3,4]},'stop':{'exit':0}},'preenqueue_crash':crash,'restart_nonce_unchanged':True,'gas_expenditure_recorded':True,'origin_progress_during_receipt_stall':True,**{k:{'exit':0}for k in ['validator_stop','first_stop','restart_stop','stalled_stop']},'fault_injection':{'self_test':{'positive_real_write_sigkill':True,'unrelated_path_negative_control':True,'write_modes':['write','pwrite','writev','pwrite64'],'path_negative_count':4}}}
 def test_actual_process_validator_rejects_599s_wrong_binary_bad_stop_batch_or_fault(self):
  value=self.process();self.assertEqual(set(proof.validate('relayer_process',value,'a'*64,ROOT)),{'three-ISM','batch4','WAL-recovery'})
  changes=[lambda v:v['settlement']['first_live_completion'].update(monotonic=699),lambda v:v['binaries'].update(relayer_sha256_chunks=['b'*64]),lambda v:v['first_stop'].update(exit=-9),lambda v:v['max_batch_4']['actual_allocation'].update(calls=3),lambda v:v['fault_injection']['self_test'].update(path_negative_count=3)]
  for mutate in changes:
   changed=copy.deepcopy(value);mutate(changed)
   with self.assertRaises(RuntimeError):proof.validate('relayer_process',changed,'a'*64,ROOT)
 def test_wss_validator_preserves_historical_provenance_and_exact_retirement(self):
  s=self.settlement(2);s['historical_confirmed_offset']=3;s['operations_confirmed']=5;s['first_live_completion']['confirmed']=5
  value={'passed':True,'executables':{'relayer_sha256_chunks':['a'*64]},'case':{'passed':True,'restart':{'existing_rust_rows_unchanged':True,'nonce_increase':2,'sigterm':{'exit':0},'settlement':s},'late_and_stalled_origin':{'sigterm':{'exit':0}}}}
  proof.validate('relayer_stream',value,'a'*64,ROOT);value['case']['restart']['nonce_increase']=3
  with self.assertRaises(RuntimeError):proof.validate('relayer_stream',value,'a'*64,ROOT)
 def test_owner_keeps_original_two_hour_four_gib_and_no_timing_acceptance(self):
  import paired_linux_owner as owner
  self.assertEqual(owner.PROFILES['functional'],{'wall_seconds':7200,'RSS_bytes':4*1024**3,'new_disk_bytes':512*1024**2,'free_bytes':6*1024**3})
  source=(HERE/'paired_linux_owner.py').read_text();self.assertIn("time.monotonic()<deadline and cleanup",source);self.assertIn('os.WNOWAIT',source)

class OwnerPublication(unittest.TestCase):
 setUp=Controls.setUp
 process=Controls.process
 settlement=Controls.settlement
 # Reuse only the DTO constructors, not inherited test collection below.
 def fixture(self):
  import paired_linux_owner as owner
  out=self.root/'owned';out.mkdir();inputs=self.root/'inputs';inputs.mkdir();request_file=self.root/'request';request_file.write_bytes(b'public fixture');rp=p.pin(request_file)
  (inputs/'input-manifest.json').write_text(json.dumps({'artifacts':{'zig':{'ReleaseSafe':{'relayer':{'sha256':'a'*64},'validator':{'sha256':'b'*64}}}}}))
  raw=self.process();proof_path=out/'proof.json';proof_path.write_text(json.dumps(raw));summary=proof.validate('relayer_process',raw,'a'*64,ROOT)
  for name,source in [('zig/bench/paired_linux_proofs.py',HERE/'paired_linux_proofs.py'),('zig/bench/relayer.py',ROOT/'zig/bench/relayer.py')]:
   target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(source.read_bytes())
  authority={'required_source':[{**p.pin(self.repo/name),'path':name}for name in ['zig/bench/paired_linux_proofs.py','zig/bench/relayer.py']]}
  value={'schema':1,'kind':'paired-linux-functional-result','platform':'linux-x86_64','passed':True,'index':0,'mode':'ReleaseSafe','proof_kind':'relayer_process','request':rp,'production_confirm_seconds':600,'bounded_grace_seconds':30,'native18_or_timing_acceptance':False,'input_manifest':p.pin(inputs/'input-manifest.json'),'proof':p.pin(proof_path),'actual_role_launches':[{'pid':123,'mode':'ReleaseSafe','binary_sha256':'a'*64}],'strict_cases':summary};p.write(out/'functional-result.json',value)
  return owner,N(phase='functional',output=out,repo=self.repo,inputs=inputs,index=0),authority,rp
 def test_actual_parent_requires_crossbound_worker_raw_proof_and_roles(self):
  owner,args,authority,request_pin=self.fixture();self.assertEqual(owner.completed_worker(args,authority,request_pin),p.pin(args.output/'functional-result.json'))
  path=args.output/'functional-result.json';original=path.read_bytes()
  for mutate in [lambda v:v.update(index=1),lambda v:v.update(actual_role_launches=[]),lambda v:v.update(native18_or_timing_acceptance=True),lambda v:v['request'].update(sha256='f'*64)]:
   v=json.loads(original);mutate(v);path.write_text(json.dumps(v))
   with self.assertRaises(p.Refused):owner.completed_worker(args,authority,request_pin)
  path.write_bytes(original);(args.output/'proof.json').write_text('{}')
  with self.assertRaises(p.Refused):owner.completed_worker(args,authority,request_pin)
 def test_actual_owner_late_zero_and_RSS_failure_still_clean_and_never_pass(self):
  import contextlib
  import paired_linux_owner as owner
  for case in ['late','rss']:
   args=N(phase='functional',request=self.root/'request',request_sha256='a'*64,repo=self.repo,inputs=self.root/'inputs',index=0,output=self.root/('outer-'+case));child=N(pid=123);custody=mock.Mock();custody.allocated.return_value=0;custody.processes.return_value={};custody.owned_processes.return_value={123:{'rss_bytes':4*1024**3+1 if case=='rss'else 1}};custody.stop_owned.return_value={'actual_parent_wait':True,'exit_code':0,'clean':True,'signals':[],'errors':[]}
   clock=iter([0,1,7201,7202,7203,7204])
   with contextlib.ExitStack()as stack:
    for target,name,replacement in [(owner.policy,'request',mock.Mock(return_value=({'root_approved':True,'functional_enabled':True},{'sha256':'a'*64}))),(owner.policy,'load_source',mock.Mock(return_value=custody)),(owner.sys,'platform','linux'),(owner.os,'pidfd_open',mock.Mock()),(owner.signal,'pidfd_send_signal',mock.Mock()),(owner.signal,'getsignal',mock.Mock(return_value=0)),(owner.signal,'signal',mock.Mock()),(owner.signal,'pthread_sigmask',mock.Mock(return_value=set())),(owner.shutil,'disk_usage',mock.Mock(return_value=N(free=7*1024**3))),(owner.subprocess,'Popen',mock.Mock(return_value=child)),(owner.os,'waitid',mock.Mock(return_value=N())),(owner.time,'monotonic',mock.Mock(side_effect=lambda:next(clock)))]:stack.enter_context(mock.patch.object(target,name,replacement,create=True))
    with self.assertRaises(p.Refused):owner.owner(args)
   custody.stop_owned.assert_called_once();row=json.loads((args.output/'owner-result.json').read_text());self.assertFalse(row['passed']);self.assertEqual(row['cleanup']['exit_code'],0);self.assertEqual(row['error_type'],'Refused');self.assertIsNone(row['worker_receipt']);self.assertEqual(row['minimum_host_free_bytes'],7*1024**3)
 def test_proof_parser_allows_large_actual_shape_but_retains_structure_bounds(self):
  # Current accepted historical process schema had353061 values; this generated
  # public-only DTO tests equivalent parser scale without borrowing any proof.
  raw=json.dumps({'observations':[0]*353061}).encode()
  with self.assertRaises(p.Refused):p.decode(raw)
  self.assertEqual(len(p.decode(raw,64*1024**2,2000000)['observations']),353061)
  with self.assertRaises(p.Refused):p.decode(raw,len(raw)-1,2000000)
 def test_fixture_parent_symlink_is_refused_before_foreign_directory_creation(self):
  source=self.root/'published';source.mkdir();f=source/'data';f.write_bytes(b'data');foreign=self.root/'foreign';foreign.mkdir();cache=self.repo/'zig/integration/.cache';cache.parent.mkdir(parents=True);cache.symlink_to(foreign,target_is_directory=True);row={**p.pin(f),'path':'data'}
  with self.assertRaises(p.Refused):stage.materialize({'repository_fixture_files':[{'repository_path':'zig/integration/.cache/new/file','file':row}]},source,self.repo)
  self.assertEqual(list(foreign.iterdir()),[])

def default_utility_workflow_inverse(text):
 step='      - name: Build complete default utility targets\n        timeout-minutes: 10\n        run: python3 zig/tools/zig.py build -Dtarget=native -Dcpu=baseline -j"${BUILD_JOBS}" -Doptimize=${{ matrix.mode }} --summary all\n'
 if text.count(step)!=1:raise AssertionError('Exact bounded default utility build required')
 return text.replace(step,'',1)

class Workflow(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.text=(Path(p.__file__).resolve().parents[2]/'.github/workflows/zig-agents.yml').read_text();tree=ast.parse((HERE.parents[1]/'zig/tools/aleo_linux/kernel_only_test.py').read_text());ns={'re':re,'N':N};exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='conditions'],type_ignores=[]),'actual-condition-reader','exec'),ns);cls.rows=ns['conditions'](cls.text);cls.ordinary_rows=ns['conditions'](ordinary_native_http_workflow(cls.text))
 def evaluate(self,rows,event='push',ref='refs/heads/feat/zig-agent-rewrite',message='',paired=False,functional=False,runtime=False,**flags):
  scope={'github':N(event_name=event,ref=ref,event=N(head_commit=N(message=message))),'inputs':N(paired_linux=paired,svm_prerequisites=flags.get('svm',False),cold_full_feature=flags.get('cold',False),aleo_linux_prerequisite=flags.get('aleo',False),aleo_linux_sdk_prerequisite=flags.get('sdk',False),aleo_native_docker_prerequisite=flags.get('docker',False),aleo_full_case=flags.get('full',False)),'needs':N(paired_linux_inputs=N(outputs=N(functional_enabled=str(functional).lower(),runtime_enabled=str(runtime).lower(),handoff_enabled=str(flags.get('handoff',False)).lower()))),'contains':lambda text,needle:needle in text}
  selected=set()
  for name,value in rows.items():
   code=value.removeprefix('${{ ').removesuffix(' }}').replace('needs.paired-linux-inputs','needs.paired_linux_inputs');code=re.sub(r'!(?!=)',' not ',code).replace('&&',' and ').replace('||',' or ').strip()
   if eval(compile(code,'actual-job-if','eval'),{'__builtins__':{}},scope):selected.add(name)
  return selected
 def legacy(self):
  pd="((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux))"
  block="      paired_linux:\n        description: Run reviewed Linux paired input/proof preparation; timings require separate final authority\n        type: boolean\n        default: false\n"
  text=ordinary_native_http_workflow(self.text).split('  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0].rstrip()+'\n';text=text.replace(block,'',1);prefix='    if: ${{ !'+pd+' && (';lines=[];count=0
  for line in text.splitlines(True):
   if line.startswith(prefix):line='    if: ${{ '+line[len(prefix):-5]+' }}\n';count+=1
   lines.append(line)
  self.assertEqual(count,15);return ''.join(lines)
 def test_actual18jobs_exact_old15_byte_inverse(self):
  self.assertEqual(len(self.rows),18);self.assertEqual(hashlib.sha256(self.legacy().encode()).hexdigest(),'3d14d7c59bf11e9b791d75bc0abbf179'+'7b4705290ed0340dd62d6d7b23a94f72')
 def test_six_foundry_callers_use_fixed_verified_recipe_and_preserve_existing_gates(self):
  names=['native-linux','evm','native-case-producer-inputs','paired-linux-inputs','paired-linux-functional','paired-linux-runtime'];seen=[]
  for name in names:
   body=re.split(r'\n  [a-z][a-z0-9-]*:\n',self.text.split('\n  '+name+':',1)[1],maxsplit=1)[0]
   block=body.split('      - name: Install verified official Foundry v1.5.0\n',1)[1].split('      - ',1)[0];seen.append(block)
   for command in ['python3 -I -B -W error zig/tools/foundry_official_test.py -v','python3 -I -B zig/tools/foundry_official.py','--runner-temp "$RUNNER_TEMP"','--gh "$(readlink -f "$(command -v gh)")"','echo "$RUNNER_TEMP/ziggy-foundry-v1.5.0/bin" >> "$GITHUB_PATH"']:self.assertIn(command,block)
  self.assertEqual(sum('        if: 'in b for b in seen),3);self.assertNotIn('foundry-rs/foundry-toolchain@',self.text)
  required={'zig/tools/foundry_official.py','zig/tools/foundry_official_test.py','zig/tools/foundry_public_good_root.json'};self.assertTrue(required<=p.SOURCE_PATHS);self.assertEqual(len(p.SOURCE_PATHS),37)
  aleo=self.text.split('\n  aleo-full-case:',1)[1].split('\n  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0];self.assertNotIn('foundry_official',aleo)
 def test_foundry_token_is_only_six_steps_and_existing_job_permissions_unchanged(self):
  names=['native-linux','evm','native-case-producer-inputs','paired-linux-inputs','paired-linux-functional','paired-linux-runtime'];self.assertEqual(self.text.count('FOUNDRY_GITHUB_TOKEN: ${{ github.token }}'),6)
  for name in names:
   body=re.split(r'\n  [a-z][a-z0-9-]*:\n',self.text.split('\n  '+name+':',1)[1],maxsplit=1)[0]
   step=body.split('      - name: Install verified official Foundry v1.5.0\n',1)[1].split('      - ',1)[0];self.assertIn('        env:\n          FOUNDRY_GITHUB_TOKEN: ${{ github.token }}\n',step);self.assertEqual(body.count('FOUNDRY_GITHUB_TOKEN:'),1);self.assertIn('cat -- "$RUNNER_TEMP/ziggy-foundry-v1.5.0/result.json"',step);order=[step.index(c)for c in ['python3 -I -B zig/tools/foundry_official.py','cat --','echo "$RUNNER_TEMP/ziggy-foundry-v1.5.0/bin"']];self.assertEqual(order,sorted(order))
   permission=re.search(r'^    permissions:\n((?:      [^\n]+\n)+)',body,re.M)
   if name in {'native-linux','evm'}:self.assertIsNone(permission)
   else:self.assertIsNotNone(permission);self.assertEqual(dict(re.findall(r'^      ([a-z-]+): ([a-z]+)$',permission[1],re.M)),{'contents':'read','actions':'read'})
 def svm_wrapper(self):
  step=self.text.split('      - name: Provision then compile exact SVM prerequisites\n',1)[1].split('      - uses:',1)[0];source=step.split("<<'PY'\n",1)[1].rsplit('          PY\n',1)[0];return step,'\n'.join(line[10:]for line in source.splitlines())+'\n'
 def run_svm_wrapper(self,rustup='/runner/toolchain/rustup',executable=True,token=True):
  _,source=self.svm_wrapper();environment={'GITHUB_WORKSPACE':'/workspace/source','RUNNER_TEMP':'/runner/tmp','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'4','PATH':'/foreign/bin','HOME':'/private/home','GH_TOKEN':'foreign-token','AWS_SECRET_ACCESS_KEY':'foreign-key'}
  if token:environment['SVM_GITHUB_TOKEN']='test-token-not-for-argv'
  calls=[];self.svm_wrapper_calls=calls;fake_os=N(environ=environment,X_OK=os.X_OK,access=lambda path,mode:executable,execve=lambda path,argv,env:calls.append((path,argv,env)));fake_shutil=N(which=lambda name:rustup if name=='rustup'else None)
  def importer(name,*args,**kwargs):return {'os':fake_os,'shutil':fake_shutil}[name]
  exec(compile(source,'actual-SVM-step-clean-exec','exec'),{'__builtins__':{'__import__':importer,'RuntimeError':RuntimeError}});return calls
 def test_svm_step_token_is_only_clean_exec_environment_never_argv(self):
  calls=self.run_svm_wrapper();self.assertEqual(len(calls),1);path,argv,environment=calls[0];self.assertEqual(path,'/usr/bin/python3');self.assertEqual(argv,['/usr/bin/python3','-I','-B','zig/tools/svm_prerequisites.py','--execute','--repo','/workspace/source','--output','/runner/tmp/svm-prerequisites-123-4','--rustup','/runner/toolchain/rustup','--bwrap','/usr/bin/bwrap']);self.assertEqual(environment,{'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8','SVM_GITHUB_TOKEN':'test-token-not-for-argv'});self.assertNotIn('test-token-not-for-argv',argv);self.assertNotIn('foreign-token',repr(calls));self.assertNotIn('foreign-key',repr(calls))
 def test_svm_wrapper_missing_rustup_nonexec_or_missing_token_never_executes(self):
  for kwargs,error in [(dict(rustup=None),RuntimeError),(dict(executable=False),RuntimeError),(dict(token=False),KeyError)]:
   with self.subTest(kwargs=kwargs),self.assertRaises(error):self.run_svm_wrapper(**kwargs)
   self.assertEqual(self.svm_wrapper_calls,[])
 def test_svm_token_scope_keeps_original_isolation_and_step_budget(self):
  step,source=self.svm_wrapper();self.assertEqual(self.text.count('SVM_GITHUB_TOKEN: ${{ github.token }}'),1);self.assertIn('        env:\n          SVM_GITHUB_TOKEN: ${{ github.token }}\n',step);self.assertIn('timeout-minutes: 182',step);self.assertIn('exec /usr/bin/python3 -I -B -',step);self.assertNotIn('env -i',step);self.assertNotIn('SVM_GITHUB_TOKEN=',step);self.assertNotIn('print(',source);self.assertNotIn('open(',source)
 def test_old_routes_preserved_across_all_existing_contexts(self):
  old={k:v for k,v in self.ordinary_rows.items()if not k.startswith('paired-linux-')};pd="((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux))";prefix='${{ !'+pd+' && (';old={k:'${{ '+v[len(prefix):-4]+' }}'for k,v in old.items()}
  count=0
  for event,ref,message,svm,cold,sdk,aleo in itertools.product(['push','pull_request','workflow_dispatch'],['refs/heads/main','refs/heads/feat/zig-agent-rewrite'],['ordinary','[zig-native-case]','[zig-svm-prerequisites-only]'],[False,True],[False,True],[False,True],[False,True]):
   kw=dict(event=event,ref=ref,message=message,svm=svm,cold=cold,sdk=sdk,aleo=aleo);self.assertEqual(self.evaluate(self.rows,**kw),self.evaluate(old,**kw));count+=1
  self.assertEqual(count,288)
 def test_explicit_marker_dispatch_phase_outputs_and_conflicts(self):
  for flags in [dict(message='[zig-paired-linux]'),dict(event='workflow_dispatch',paired=True)]:
   self.assertEqual(self.evaluate(self.rows,**flags),{'paired-linux-inputs'})
   self.assertEqual(self.evaluate(self.rows,functional=True,**flags),{'paired-linux-inputs','paired-linux-functional'})
   self.assertEqual(self.evaluate(self.rows,functional=True,runtime=True,**flags),{'paired-linux-inputs','paired-linux-functional'})
  self.assertEqual(self.evaluate(self.rows,message='[zig-native-case] [zig-paired-runtime]'),{'native-case-producer-inputs','paired-linux-runtime'})
  for key,marker in [('aleo','kernel'),('sdk','sdk'),('docker','docker'),('full','fullcase')]:
   self.assertEqual(self.evaluate(self.rows,event='workflow_dispatch',paired=True,**{key:True}),set());self.assertEqual(self.evaluate(self.rows,message='[zig-paired-linux] [zig-aleo-'+marker+'-only]'),set())
  for event,ref in [('pull_request','refs/heads/feat/zig-agent-rewrite'),('push','refs/heads/main')]:self.assertFalse(any(k.startswith('paired-linux-')for k in self.evaluate(self.rows,event=event,ref=ref,message='[zig-paired-linux]')))
 def test_only_new_input_job_uses_explicit_canonical_PG16(self):
  job=self.text.split('\n  paired-linux-inputs:',1)[1].split('\n  paired-linux-functional:',1)[0];self.assertIn('PAIRED_PG16_DIGEST_A: 43f9275df91e012c3da3d86bea5d7bb5',job);self.assertIn('PAIRED_PG16_DIGEST_B: e67a473296cc906c5f9e80b8176b1a37',job);self.assertIn('docker pull "postgres@sha256:${PAIRED_PG16_DIGEST_A}${PAIRED_PG16_DIGEST_B}"',job)
  self.assertIn('POSTGRES_DIGEST_A: 933463a6c8eba2b9f5cd414138738cd8',self.legacy());self.assertNotIn('PAIRED_PG16_DIGEST',self.legacy())
 def test_fixed_six_and_ten_matrices_limits_and_timing_refusal(self):
  functional=self.text.split('\n  paired-linux-functional:',1)[1].split('\n  paired-linux-runtime:',1)[0];runtime=self.text.split('\n  paired-linux-runtime:',1)[1]
  self.assertIn('index: [0, 1, 2, 3, 4, 5]',functional);self.assertIn('max-parallel: 2',functional);self.assertIn('timeout-minutes: 180',functional);self.assertIn('timeout-minutes: 122',functional);self.assertIn('index: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]',runtime);self.assertIn('max-parallel: 2',runtime);self.assertIn('paired_linux_runtime_ci.py select',runtime);self.assertIn("if: steps.runtime.outputs.runtime_enabled == 'true'",runtime);self.assertIn('exec env -u GH_TOKEN python3 -I -B zig/bench/paired_linux_runtime_owner.py',runtime);self.assertIn('timeout-minutes: 306',runtime);self.assertNotIn('paired_linux_owner.py',runtime)

class AdmissionFailureDiagnostics(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.repo=Path(self.tmp.name).resolve();self.path=self.repo/'diagnostic.py'
 def failure(self,source,extra=None):
  self.path.write_text(source);namespace={'p':p,'reader':reader,**(extra or{})};exec(compile(source,str(self.path),'exec'),namespace)
  try:namespace['fail']()
  except BaseException as error:return error,{'required_source':[{**p.pin(self.path),'path':self.path.name}]}
  self.fail('expected controlled failure')
 def test_exact_policy_and_archive_guard_frames_use_checked_captured_Source(self):
  for call,guard in [('p.need','consumer CPU superset'),('reader.need','ZIP_SPECIAL_OR_LINK')]:
   error,authority=self.failure('def fail():\n '+call+'(False,"'+guard+'")\n');result=stage.failure_observation(error,self.repo,authority)
   self.assertEqual(result['Source_guard'],guard);self.assertEqual(result['error_type'],'Refused');self.assertEqual(result['status'],'observed');self.assertEqual(result['Source_frames'],[{'source':'diagnostic.py','sha256':p.pin(self.path)['sha256'],'line':2,'function':'fail'}])
 def test_foreign_and_changed_Source_never_grant_guard_or_frames(self):
  error,authority=self.failure('def fail():\n p.need(False,"consumer CPU superset")\n')
  self.assertEqual(stage.failure_observation(error,self.repo,{'required_source':[]})['Source_frames'],[])
  self.path.write_text('def fail():\n p.need(False,"consumer GPU superset")\n')
  result=stage.failure_observation(error,self.repo,authority);self.assertEqual(result['Source_frames'],[]);self.assertIsNone(result['Source_guard'])
 def test_guard_literal_must_be_on_actual_failing_Source_line(self):
  error,authority=self.failure('def fail():\n if False:p.need(False,"consumer CPU superset")\n raise p.Refused("consumer CPU superset")\n')
  result=stage.failure_observation(error,self.repo,authority);self.assertEqual(result['Source_frames'][0]['line'],3);self.assertIsNone(result['Source_guard'])
 def test_private_exception_payload_class_and_nested_values_never_export(self):
  sentinel='private-token-body-argv-environment-sentinel'
  for value in [sentinel,{'nested':sentinel}]:
   error,authority=self.failure('def fail():\n raise ValueError(payload)\n',{'payload':value});result=stage.failure_observation(error,self.repo,authority);self.assertIsNone(result['Source_guard']);self.assertNotIn(sentinel,json.dumps(result))
  private=type(sentinel,(RuntimeError,),{});error,authority=self.failure('def fail():\n raise Private(payload)\n',{'Private':private,'payload':sentinel});result=stage.failure_observation(error,self.repo,authority);self.assertEqual(result['error_type'],'OtherError');self.assertNotIn(sentinel,json.dumps(result))
 def test_capture_depth_frame_and_Source_byte_budgets_are_bounded(self):
  error,authority=self.failure('def recurse(n):\n if n:return recurse(n-1)\n p.need(False,"consumer CPU superset")\ndef fail():\n recurse(40)\n');result=stage.failure_observation(error,self.repo,authority);self.assertEqual(len(result['Source_frames']),16);self.assertIsNone(result['Source_guard'])
  authority['required_source'][0]['bytes']=2*1024**2+1
  with mock.patch.object(Path,'open',side_effect=AssertionError('oversized Source must not be read')):result=stage.failure_observation(error,self.repo,authority)
  self.assertEqual(result['Source_frames'],[]);self.assertIsNone(result['Source_guard'])
 def actual_boundary(self,primary=None,diagnostic=None):
  tree=ast.parse((HERE/'paired_linux_stage.py').read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');node=copy.deepcopy(next(n for n in fn.body if isinstance(n,ast.Try)))
  node.body=ast.parse('raise primary'if primary is not None else 'pass').body;code=compile(ast.fix_missing_locations(ast.Module(body=[node,copy.deepcopy(fn.body[-1])],type_ignores=[])),str(HERE/'paired_linux_stage.py'),'exec');events=[];saved=[]
  def write(path,value):events.append('write');saved.append(copy.deepcopy(value))
  error,authority=self.failure('def fail():\n p.need(False,"consumer CPU superset")\n')
  env={'policy':p,'args':N(repo=self.repo,output=self.repo/'out'),'authority':authority,'remote':None,'error':None,'observation':None,'receipt':None if primary is not None else {'schema':1,'passed':True},'primary':primary,'runner':N(summary=lambda:events.append('summary')or{'all_calls_actually_waited':True}),'restore_interrupts':lambda previous:events.append('restore'),'previous':{}}
  with mock.patch.object(p,'write',side_effect=write):
   env['failure_observation']=stage.failure_observation if diagnostic is None else diagnostic
   try:exec(code,env)
   except BaseException as raised:return env,saved,events,raised
  return env,saved,events,None
 def test_actual_except_finally_keeps_primary_failure_when_diagnostic_raises(self):
  primary=p.Refused('consumer CPU superset');env,saved,events,raised=self.actual_boundary(primary,lambda *args:(_ for _ in ()).throw(ValueError('private diagnostic failure')))
  self.assertIsInstance(raised,p.Refused);self.assertEqual(raised.args,('input consumer failed; closed receipt retained',));self.assertEqual(env['error'],'Refused');self.assertFalse(saved[0]['passed']);self.assertEqual(saved[0]['error_type'],'Refused');self.assertEqual(saved[0]['failure_observation'],{'status':'unavailable'});self.assertEqual(events,['summary','write','restore']);self.assertNotIn('private diagnostic failure',json.dumps(saved))
 def test_actual_except_publishes_only_closed_failure_observation(self):
  primary,authority=self.failure('def fail():\n p.need(False,"consumer CPU superset")\n');observed=stage.failure_observation(primary,self.repo,authority)
  env,saved,events,raised=self.actual_boundary(primary,lambda *args:observed)
  self.assertIsInstance(raised,p.Refused);self.assertEqual(saved[0]['failure_observation']['Source_guard'],'consumer CPU superset');self.assertEqual(events,['summary','write','restore']);self.assertFalse(saved[0]['native18_or_timing_acceptance'])
 def test_actual_success_boundary_never_calls_diagnostic_or_changes_receipt_shape(self):
  env,saved,events,raised=self.actual_boundary(diagnostic=lambda *args:(_ for _ in ()).throw(AssertionError('success invoked failure diagnostic')))
  self.assertIsNone(raised);self.assertEqual(saved,[{'schema':1,'passed':True,'actual_commands':{'all_calls_actually_waited':True}}]);self.assertEqual(events,['summary','write','restore'])

class ExternalToolMismatchDiagnostics(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.tool=self.root/'PRIVATE_TOOL_PATH';self.tool.write_bytes(b'PRIVATE_FIRST');self.expected=p.pin(self.tool);self.repo=Path(p.__file__).resolve().parents[2];self.authority={'required_source':[{**p.pin(Path(p.__file__).resolve()),'path':'zig/bench/paired_linux.py'}]}
 def changed(self,name='pnpm'):
  self.tool.write_bytes(b'PRIVATE_OTHER')
  try:p.checked(self.expected,external_tool=name)
  except p.Refused as error:return error
  self.fail('actual changed tool passed')
 def test_actual_changed_tool_captures_single_checked_operands_without_path_or_body(self):
  error=self.changed();self.assertEqual(error.args,('input bytes changed',));expected={'name':'pnpm','expected':{k:self.expected[k]for k in ['bytes','sha256']},'actual':{k:p.pin(self.tool)[k]for k in ['bytes','sha256']}};self.assertEqual(error.external_tool_mismatch,expected)
  with mock.patch.object(p,'pin',side_effect=AssertionError('diagnostic must not reobserve tool')):value=stage.failure_observation(error,self.repo,self.authority)
  self.assertEqual(value['Source_guard'],'input bytes changed');self.assertEqual(value['external_tool_mismatch'],expected);self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn(str(self.tool),json.dumps(value))
 def test_unchanged_tool_and_ordinary_group_mismatch_keep_original_behavior(self):
  self.assertEqual(p.checked(self.expected,external_tool='pnpm'),p.pin(self.tool));self.tool.write_bytes(b'PRIVATE_OTHER')
  for name in [None,'PRIVATE_UNKNOWN']:
   try:p.checked(self.expected,external_tool=name)
   except p.Refused as error:self.assertEqual(error.args,('input bytes changed',));self.assertFalse(hasattr(error,'external_tool_mismatch'))
   else:self.fail('mismatch healed')
 def test_unknown_nested_bool_overflow_or_unapproved_Source_never_publish(self):
  error=self.changed();valid=copy.deepcopy(error.external_tool_mismatch)
  bad=[dict(valid,name='PRIVATE_UNKNOWN'),dict(valid,actual={'bytes':True,'sha256':'a'*64}),dict(valid,actual={'bytes':2*stage.GIB+1,'sha256':'a'*64}),dict(valid,actual={'bytes':1,'sha256':{'PRIVATE':'data'}}),dict(valid,actual={'bytes':1,'sha256':'a'*64,'path':'PRIVATE'})]
  for row in bad:
   error.external_tool_mismatch=row;value=stage.failure_observation(error,self.repo,self.authority);self.assertNotIn('external_tool_mismatch',value);self.assertNotIn('PRIVATE',json.dumps(value))
  error.external_tool_mismatch=valid;self.assertNotIn('external_tool_mismatch',stage.failure_observation(error,self.repo,{'required_source':[]}))
 def test_exact_actual_external_tool_loop_supplies_name_without_new_pin_calls(self):
  tree=ast.parse(Path(p.__file__).read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='input_manifest');loop=next(n for n in fn.body if isinstance(n,ast.For)and isinstance(n.target,ast.Name)and n.target.id=='name'and isinstance(n.iter,ast.Name)and n.iter.id=='required_tools');calls=[n for n in ast.walk(loop)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='checked'];self.assertEqual(len(calls),1);self.assertEqual([(k.arg,ast.unparse(k.value))for k in calls[0].keywords],[('external_tool','name')])


class FunctionalFailureDiagnosticsControls(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.repo=self.root/'repo';self.out=self.root/'out';self.out.mkdir();self.args=N(repo=self.repo,output=self.out,index=0)
  file=self.repo/'zig/bench/paired_linux_stage.py';file.parent.mkdir(parents=True);file.write_bytes((HERE/'paired_linux_stage.py').read_bytes());self.authority={'required_source':[{**p.pin(file),'path':'zig/bench/paired_linux_stage.py'}]};self.request={'path':'/CI/request.json','bytes':1,'sha256':'a'*64}
  import paired_linux_owner as owner
  self.owner=owner
 def test_actual_Source_stage_dependencies_and_guard_are_reused(self):
  file=self.repo/'zig/integration/control.py';file.parent.mkdir(parents=True);file.write_text('def fail():\n p.need(False,"fixed functional guard")\n');self.authority['required_source'].append({**p.pin(file),'path':'zig/integration/control.py'});space={'p':p};exec(compile(file.read_text(),str(file),'exec'),space)
  try:space['fail']()
  except p.Refused as error:self.owner.functional_failure(error,self.args,self.authority,self.request,'ReleaseSafe','relayer_process')
  value=json.loads((self.out/'functional-failure.json').read_text());self.assertFalse(value['passed']);self.assertFalse(value['native18_or_timing_acceptance']);self.assertEqual(value['failure_observation']['Source_guard'],'fixed functional guard');self.assertEqual(value['failure_observation']['Source_frames'][-1]['source'],'zig/integration/control.py')
 def test_HTTP_metadata_never_exports_URL_reason_headers_or_body(self):
  from urllib.error import HTTPError
  sentinel='PRIVATE_HTTP_SENTINEL'
  cases=[('http://127.0.0.1:1/list_operations?'+sentinel,'list_operations'),('https://localhost/metrics','metrics'),('http://[::1]/','chain_rpc'),('http://127.0.0.1/'+sentinel,'other_loopback'),('https://remote.invalid/'+sentinel,'unavailable'),('http://[broken','unavailable')]
  for url,route in cases:
   with self.subTest(route=route):
    (self.out/'functional-failure.json').unlink(missing_ok=True)
    error=HTTPError(url,500,sentinel,{'Private':sentinel},io.BytesIO(sentinel.encode()));self.owner.functional_failure(error,self.args,self.authority,self.request,'ReleaseSafe','relayer_process');wire=(self.out/'functional-failure.json').read_text();value=json.loads(wire);self.assertEqual(value['HTTP'],{'status':500,'route':route});self.assertNotIn(sentinel,wire);self.assertNotIn(url,wire);self.assertNotIn('headers',wire)
 def test_invalid_HTTP_status_and_failed_Source_observer_remain_closed(self):
  from urllib.error import HTTPError
  for code in [True,99,600,'500']:
   (self.out/'functional-failure.json').unlink(missing_ok=True)
   with mock.patch.object(p,'load_source',side_effect=RuntimeError('PRIVATE_DIAGNOSTIC')):
    self.owner.functional_failure(HTTPError('http://localhost/',code,'PRIVATE_REASON',None,None),self.args,self.authority,self.request,'ReleaseSafe','relayer_process')
   wire=(self.out/'functional-failure.json').read_text();value=json.loads(wire);self.assertIsNone(value['HTTP']['status']);self.assertEqual(value['failure_observation'],{'status':'unavailable'});self.assertNotIn('PRIVATE',wire)
 def test_actual_worker_bare_rethrow_survives_diagnostic_write_failure(self):
  tree=ast.parse((HERE/'paired_linux_owner.py').read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');node=next(n for n in worker.body if isinstance(n,ast.Try));primary=AssertionError('PRIVATE_PRIMARY');saved=[];warnings=io.StringIO()
  def fail():raise primary
  scope={'module':N(main=fail),'policy':N(write=lambda path,value:saved.append((path.name,value))),'args':self.args,'events':[],'functional_failure':mock.Mock(side_effect=OSError('PRIVATE_SECONDARY')),'authority':self.authority,'request_pin':self.request,'mode':'ReleaseSafe','kind':'relayer_process','sys':N(stderr=warnings)}
  with self.assertRaises(AssertionError)as caught:exec(compile(ast.Module(body=[node],type_ignores=[]),str(HERE/'paired_linux_owner.py'),'exec'),scope)
  self.assertIs(caught.exception,primary);self.assertEqual([name for name,_ in saved],['actual-agent-launches.json']);self.assertEqual(warnings.getvalue(),'FUNCTIONAL_DIAGNOSTIC_WRITE_FAILED\n')
 def test_actual_worker_also_records_postmain_proof_validation_failure(self):
  tree=ast.parse((HERE/'paired_linux_owner.py').read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');node=next(n for n in worker.body if isinstance(n,ast.Try));record=mock.Mock();saved=[];path=self.out/'proof.json';path.write_text('{}')
  scope={'module':N(main=lambda:None),'policy':N(write=lambda path,value:saved.append(path.name),decode_proof=p.decode_proof),'proof':path,'args':self.args,'events':[],'functional_failure':record,'authority':self.authority,'request_pin':self.request,'mode':'ReleaseSafe','kind':'relayer_process','value':{'artifacts':{'zig':{'ReleaseSafe':{'relayer':{'sha256':'a'*64}}}}},'sys':sys}
  with self.assertRaisesRegex(RuntimeError,'actual functional proof failed')as caught:exec(compile(ast.Module(body=[node],type_ignores=[]),str(HERE/'paired_linux_owner.py'),'exec'),scope)
  self.assertIs(record.call_args.args[0],caught.exception);self.assertEqual(saved,['actual-agent-launches.json'])

class FunctionalFailureWorkflowControls(unittest.TestCase):
 def test_exact_two_diagnostic_uploads_invert_and_poison_refuses(self):
  text=(ROOT/'.github/workflows/zig-agents.yml').read_text();block='            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/functional-failure.json\n            ${{ runner.temp }}/paired-linux-proof-${{ matrix.index }}/worker.log\n'
  self.assertEqual(text.count(block),1);ordinary_native_http_workflow(text)
  for bad in [text.replace(block,'',1),text.replace(block,block+block,1),text.replace('paired-linux-proof-${{ matrix.index }}/functional-failure.json','paired-linux-proof-${{ matrix.index }}/raw/',1),text.replace('paired-linux-proof-${{ matrix.index }}/worker.log','paired-linux-proof-${{ matrix.index }}/other.log',1)]:
   with self.assertRaises(AssertionError):ordinary_native_http_workflow(bad)

class PnpmHomeWorkflowInverseControls(unittest.TestCase):
 def test_exact_three_recipe_inverse_keeps_original_full_golden(self):
  text=(ROOT/'.github/workflows/zig-agents.yml').read_text();functions=[]
  for name in ['zig/bench/paired_linux_test.py','zig/tools/aleo_linux_case/ci_fullcase_test.py']:
   source=(ROOT/name).read_text();node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow');scope={'hashlib':hashlib};exec(compile(ast.Module([node],type_ignores=[]),'actual-pnpm-HOME-workflow-inverse','exec'),scope);functions.append(node)
   self.assertEqual(hashlib.sha256(scope['ordinary_native_http_workflow'](text).encode()).hexdigest(),'e08ffd005159dd3915047706df9a1806b' '13cf3344795e5700980910bc38f9ef3')
   hunks=[ast.literal_eval(n.value)for n in node.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='pnpm_home_after'for t in n.targets)];self.assertEqual(len(hunks),5)
   for index,hunk in enumerate(hunks):
    self.assertEqual(text.count(hunk),3)
    for changed in [text.replace(hunk,'',1),text+hunk,text.replace(hunk,'UNREVIEWED'+hunk[1:],1)]:
     with self.subTest(hunk=index),self.assertRaisesRegex(AssertionError,'Exact three reviewed pnpm HOME workflow hunks'):scope['ordinary_native_http_workflow'](changed)
  self.assertEqual(ast.dump(functions[0],include_attributes=False),ast.dump(functions[1],include_attributes=False))


class FixedPnpmClosure(unittest.TestCase):
 def test_two_existing_helpers_are_required_without_dropping_old_members(self):
  self.assertTrue({'zig/bench/native_tron_setup.py','zig/bench/native_tron_assets.py'}<=p.SOURCE_PATHS)
 def test_identical_native_file_passes_but_changed_launcher_is_not_waived(self):
  with tempfile.TemporaryDirectory()as directory:
   path=Path(directory).resolve()/'pnpm';elf=b'\x7fELF\x02\x01'+b'fixed-native-fixture';path.write_bytes(elf);row=p.pin(path);self.assertEqual(p.checked(row,external_tool='pnpm'),row);path.write_bytes(elf);self.assertEqual(p.checked(row,external_tool='pnpm'),row);path.write_bytes(b'#!/bin/sh\nexec different-local-path\n')
   with self.assertRaises(p.Refused)as caught:p.checked(row,external_tool='pnpm')
   self.assertEqual(caught.exception.args,('input bytes changed',));self.assertEqual(caught.exception.external_tool_mismatch['name'],'pnpm')
 def test_only_paired_jobs_replace_their_generated_manager_and_keep_gates(self):
  text=(HERE.parents[1]/'.github/workflows/zig-agents.yml').read_text()
  for name,gate in [('paired-linux-inputs',"steps.authority.outputs.inputs_enabled == 'true'"),('paired-linux-functional',None),('paired-linux-runtime',"steps.runtime.outputs.runtime_enabled == 'true'")]:
   body=re.split(r'\n  [a-z][a-z0-9-]*:\n',text.split('\n  '+name+':',1)[1],maxsplit=1)[0];self.assertNotIn('uses: pnpm/action-setup@',body);step=body.split('      - name: Stage exact official native pnpm12.3.0 outside all measurements\n',1)[1].split('      - ',1)[0];self.assertIn('timeout-minutes: 3',step)
   if gate:self.assertIn('        if: '+gate,step)
   else:self.assertIn('paired_linux.py select --request',step);self.assertIn('needs.paired-linux-inputs.outputs.request_sha256',step)


class EvmConsumerWorkflowInverseControls(unittest.TestCase):
 def current(self):return (HERE.parents[1]/'.github/workflows/zig-agents.yml').read_text()
 def hunks(self):
  fn=next(n for n in ast.parse(Path(__file__).read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow')
  return [ast.literal_eval(n.value)for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='evm_after'for t in n.targets)]
 def test_each_EVM_hunk_missing_duplicated_or_mutated_refuses_exact_inverse(self):
  text=self.current();ordinary_native_http_workflow(text);self.assertEqual(len(self.hunks()),3)
  for index,hunk in enumerate(self.hunks()):
   for changed in [text.replace(hunk,'',1),text+hunk,text.replace(hunk,hunk+'UNREVIEWED',1)if hunk.endswith('\n')else text.replace(hunk,hunk.replace('scenario=','scenario_UNREVIEWED='),1)]:
    # A changed line may keep the old hunk as a strict prefix; exercise a real
    # content change as well, never count unrelated trailing text as accepted.
    if hunk in changed and changed.count(hunk)==1:
     changed=text.replace(hunk,hunk.replace(hunk[0],'X',1),1)
    with self.subTest(hunk=index),self.assertRaises(AssertionError):ordinary_native_http_workflow(changed)
 def test_EVM_source_predicate_clocks_artifact_and_shared_helpers_are_exact(self):
  text=self.current();other=HERE.parents[1]/'zig/tools/aleo_linux_case/ci_fullcase_test.py'
  function=lambda p:next(n for n in ast.parse(p.read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow')
  self.assertEqual(ast.dump(function(Path(__file__))),ast.dump(function(other)))
  case=text.split('  native-case-producer-inputs:\n',1)[1].split('\n  aleo-linux-sdk-prerequisite:',1)[0]
  self.assertIn('    timeout-minutes: 190\n',case);self.assertIn('        timeout-minutes: 142\n',case)
  start=case.index('      - name: Run three independent EVM dependency controls');end=case.index('      - name: Retain only the closed independent EVM control result',start);step=case[start:end]
  self.assertLess(case.index('Hydrate, stage prerequisites'),start);self.assertIn('        timeout-minutes: 15\n',step)
  condition=next(line.strip()[len('if: ${{ '):-len(' }}')]for line in step.splitlines()if line.strip().startswith('if: ${{ '));code=condition.replace('&&',' and ')
  for success in [False,True]:
   for enabled in ['false','true']:
    for scenario in ['evm','radix','']:
     actual=eval(code,{'__builtins__':{}},{'success':lambda:success,'steps':N(request=N(outputs=N(enabled=enabled,scenario=scenario)))})
     self.assertEqual(actual,success and enabled=='true'and scenario=='evm')
  artifact=case[end:case.index('      - uses: actions/upload-artifact@',end)]
  path=next(line.strip()[len('path: '):]for line in artifact.splitlines()if line.strip().startswith('path: '))
  self.assertTrue(path.endswith('/public/result.json'));self.assertNotIn('*',path);self.assertNotIn('logs',path)
  self.assertIn('exec env -i ',step);self.assertIn('GH_TOKEN="$GH_TOKEN"',step);self.assertNotIn('printenv',step)

class PortableCpuProvenance(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.repo=Path(self.temp.name).resolve();self.producer='b'*40
  authority=[]
  for relative in ['zig/tools/build_cpu.py','zig/bench/paired_linux_inputs.py']:
   target=self.repo/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((ROOT/relative).read_bytes());authority.append({**p.pin(target),'path':relative})
  self.authority={'required_source':authority};self.cpu=p.load_source(self.repo/'zig/tools/build_cpu.py','fixture_actual_portable_policy',self.authority,self.repo)
  self.env=self.cpu.portable_environment({'PATH':'/bin'},tokio_unstable=True);self.rows=[];recipes={}
  for name in ['build-rust-three-agent','build-evm-recover-oracle']:
   argv=['cargo','build','--locked','--offline','--release','--bin',name]
   pending=self.cpu.recipe('rust',argv,self.env,'zig/bench/paired_linux_inputs.py',self.repo)
   recipes[name]=self.cpu.finish_recipe(pending,{'actual_parent_wait':True,'exit_code':0},self.repo)
   self.rows.append({'name':name,'command':argv,'actual_parent_wait':True,'exit_code':0,'error_type':None,'owned_absent':True,'signals':[],'completed_within_original_deadline':True})
  host=sorted(set(self.cpu.REQUIRED_FLAGS)|{'avx512f'})
  def record(scope,mode,names):
   # Synthetic completed recipes exercise the real closed coverage validator;
   # no compiler is executed and no receipt is published as actual build proof.
   completed=[]
   for relative,kind,count in self.cpu.COVERAGE[scope]:
    target=self.repo/relative
    if not target.exists():target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((ROOT/relative).read_bytes())
    for index in range(count):
     if kind=='rust':argv=['cargo','build','--bin',scope+str(index)]
     elif kind=='cc':argv=['c++',*__import__('shlex').split(self.cpu.C_FLAGS),'-c',scope+str(index)+'.cc']
     elif kind=='zig-build':argv=['zig','build',*self.cpu.zig_cpu_args('build'),'-Dfixture='+str(index)]
     else:argv=['zig','build-exe',*self.cpu.zig_cpu_args('direct'),scope+str(index)+'.zig']
     pending=self.cpu.recipe(kind,argv,self.env,relative,self.repo);completed.append(self.cpu.finish_recipe(pending,{'actual_parent_wait':True,'exit_code':0},self.repo))
   return self.cpu.make_record(scope,mode,self.producer,'amd64',host,{n:{'bytes':1,'sha256':'a'*64}for n in names},completed)
  self.build={'passed':True,'fixed_profile':p.PORTABLE_PROFILE,'CPU_profile':self.cpu.PROFILE,'CPU_policy_Source':authority[0],'SDK_baked_CPU':{mode:[record(scope,mode,names)for scope,names in self.cpu.SCOPES.items()]for mode in p.MODES},'helper_required_CPU':{mode:list(self.cpu.REQUIRED_FLAGS)for mode in p.MODES},'tools_CPU_contract':record('tools','shared',['init-db','ziggy-rocks-oracle','ziggy-native-rows','ziggy-rust-reference']),'writer_CPU_contracts':{label:record('writer',mode,['writer'])for label,mode in [('writer_safe','ReleaseSafe'),('writer_fast','ReleaseFast')]},'comparator_CPU_recipes':recipes,'actual_commands':self.rows,'compile_CPU_flags':host}
 def checked(self,value):return p.portable_build_provenance(value,self.repo,self.producer,self.authority)
 def test_portable_all_scope_receipts_keep_host_flags_but_require_only_target_ISA(self):
  self.assertEqual(self.checked(self.build),list(self.cpu.REQUIRED_FLAGS));self.assertIn('avx512f',self.build['compile_CPU_flags']);self.assertNotIn('avx512f',self.checked(self.build));self.assertEqual(p.BASELINE,'c5202242cc6569da4a858ed7ddbb34170ab696aa')
 def test_missing_mixed_legacy_and_wrong_producer_scopes_refuse(self):
  variants=[]
  v=copy.deepcopy(self.build);v['SDK_baked_CPU']['ReleaseSafe'].pop();variants.append(v)
  v=copy.deepcopy(self.build);v['SDK_baked_CPU']['ReleaseFast'][0]={'schema':1,'flags':['avx512f']};variants.append(v)
  v=copy.deepcopy(self.build);v['SDK_baked_CPU']['ReleaseSafe'][0]['source_commit']='d'*40;variants.append(v)
  v=copy.deepcopy(self.build);del v['helper_required_CPU']['ReleaseFast'];variants.append(v)
  v=copy.deepcopy(self.build);del v['tools_CPU_contract'];variants.append(v)
  v=copy.deepcopy(self.build);del v['writer_CPU_contracts']['writer_fast'];variants.append(v)
  v=copy.deepcopy(self.build);v['writer_CPU_contracts']['writer_safe']['schema']=1;variants.append(v)
  for value in variants:
   with self.subTest(value=value),self.assertRaises((p.Refused,ValueError)):self.checked(value)
 def test_actual_wait_command_hash_and_procedure_Source_cannot_be_fabricated(self):
  mutations=[lambda v:v['actual_commands'][0].update(actual_parent_wait=False),lambda v:v['actual_commands'][0].update(exit_code=1),lambda v:v['actual_commands'][0]['command'].append('--different'),lambda v:v['actual_commands'].append(copy.deepcopy(v['actual_commands'][0])),lambda v:v['comparator_CPU_recipes']['build-rust-three-agent']['source'].update(sha256='d'*64),lambda v:v['CPU_policy_Source'].update(sha256='d'*64)]
  for change in mutations:
   value=copy.deepcopy(self.build);change(value)
   with self.subTest(change=change),self.assertRaises((p.Refused,ValueError)):self.checked(value)
  with self.assertRaisesRegex(p.Refused,'authority'):p.portable_build_provenance(self.build,self.repo,self.producer,None)
  self.assertEqual(p.PROFILE_RUSTFLAGS[p.LEGACY_PROFILE],'--cfg tokio_unstable -Ctarget-cpu=native')
class PortableNativeLinuxWorkflowInverseControls(unittest.TestCase):
 def test_actual_native_linux_cpu_commands_are_exact_and_required(self):
  text=(HERE.parents[1]/'.github/workflows/zig-agents.yml').read_text()
  function=next(n for n in ast.parse(Path(__file__).read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow')
  hunks=[ast.literal_eval(n.value)for n in function.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='portable_after'for t in n.targets)]
  self.assertEqual(len(hunks),10);ordinary_native_http_workflow(text)
  for hunk in hunks:
   for changed in [text.replace(hunk,'',1),text+hunk,text.replace(hunk,hunk.replace('python3','python_UNREVIEWED',1),1)]:
    with self.subTest(hunk=hunk[:80]),self.assertRaises(AssertionError):ordinary_native_http_workflow(changed)

def handoff_fixture(role,mode,products,manifest,producer,source):
    epochs=[];ids=[];before=[]if role=='relayer'else{}
    for index,implementation in enumerate(('rust','zig','rust')):
        identity=f'{index+1:064x}';ids.append(identity);started=10.0+index*1000
        row={'phase':'ABC'[index],'implementation':implementation,'pid':101+index,'binary_sha256':products[implementation]['sha256'],'started_monotonic':started,'ready_monotonic':started+1,'drained_monotonic':started+620,'ended_monotonic':started+621,'parent_wait':{'completed':True,'exit_code':0 if implementation=='zig'else -15,'forced':False},'store_identity':['same-owned-store',991],'store_initialized':index==0,'new_event':identity,'readiness':{'actual':True}}
        if role=='relayer':
            current=[{'id_chunks':[v[:32],v[32:]],'present':True,'processed':True,'nonce':i,'gas_expenditure_record_present':True,'spent':{'gas_used':'21000','tokens_used':'42000'}}for i,v in enumerate(ids)]
            row.update(prior_rows_before=before,prior_rows_after=before,canonical_rows=current,nonce_before=[index,0],nonce_after=[index+1,0],raw_sends_before=index,raw_sends_after=index+1,inclusion_ns=int((started+2)*10**9),retirement_ns=int((started+602)*10**9),settlement={'processed_count':1,'queues':{'confirmation':0}},accounting={'canonical_transaction_hash':'0x'+identity,'canonical_block_hash':'0x'+'a'*64,'receipt_gas_used':21000,'effective_gas_price':2,'receipt_tokens_used':42000,'database_gas_used':21000,'database_tokens_used':42000,'gas_expenditure_record_present':True,'preserved_Rust_absent_record_Source_gap':False,'exact_expenditure':True,'process_event_proof':{'status':'0x1','mailbox_emitter':'0x'+'c'*40,'process_ids':['0x'+identity]}});before=current
        elif role=='validator':
            row['readiness']={'agent':'validator','data_type':'merkle_tree_hook','chain':'test1','task':'cursor_task','launch_unix_seconds':100.5,'liveness':101,'http_status':200,'metrics_bytes':100}
            current={f'{i}_with_id.json':v for i,v in enumerate(ids)}
            row.update(prior_objects_before=before,prior_objects_after=before,objects_after=current,signature_count_verified=index+1,nonce_before=0 if index==0 else 1,nonce_after_takeover=1,nonce_after=1,metadata={'git_sha':products[implementation]['metadata_git_sha'],'rpcs':[],'allows_public_rpcs':False},expected_metadata_git_sha=products[implementation]['metadata_git_sha'],announcement_reply_sha256='e'*64,actual_URI_in_chain_reply=True);before=current
        else:
            row['store_identity']=['same_owned_database','same_owned_database|777777|12345']
            current={str(i):','.join(ids)for i in range(5)};counts={key:index+1 for key in ['raw_dispatch','messages','deliveries','gas_payments','merkle_insertions','linked_messages','linked_deliveries','linked_gas_payments']};counts.update(receipt_or_identity_mismatches=0,duplicate_rows_by_message_identity=0,head='0|10|10|10|t|f')
            row.update(prior_rows_before=before,prior_rows_after=before,rows_after=current,row_counts=counts,migrations='21',fresh_SQL_events_verified=index+1,normalized_config_sha256='d'*64);before=current
        epochs.append(row)
    actual=[{'pid':r['pid'],'direct_parent_pid':1,'implementation':r['implementation'],'role':role,'binary':{k:v for k,v in products[r['implementation']].items()if k!='metadata_git_sha'},'actual_parent_wait':True,'exit_code':r['parent_wait']['exit_code']}for r in epochs]
    if role=='relayer':actual.append({'pid':104,'direct_parent_pid':1,'implementation':'rust','role':'validator','binary':products['rust_validator_companion'],'actual_parent_wait':True,'exit_code':-15})
    return {'schema':1,'kind':'paired-linux-drained-role-handoff','passed':True,'role':role,'mode':mode,'baseline_source_commit':'c5202242cc6569da4a858ed7ddbb34170ab696aa','producer_source_commit':producer,'execution_source_commit':'a'*40,'input_manifest':manifest,'source_pins':source,'epochs':epochs,'performance_credit':False,'actual_role_launches':actual,'actual_consumer_CPU':{'required_flags':['sse2'],'available_intersection_flags':['sse2'],'cpuinfo_bytes':1,'cpuinfo_sha256':'f'*64}}



class DrainedHandoffControls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='handoff-pure-');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir()
  self.products={'rust_validator_companion':{'path':'rust/validator','bytes':2,'sha256':'9'*64},'rust':{'path':'rust/role','bytes':1,'sha256':'c'*64,'metadata_git_sha':'a'*40},'zig':{'path':'zig/role','bytes':1,'sha256':'d'*64,'metadata_git_sha':'b'*40}};self.manifest={'path':'/actual-once/manifest.json','bytes':1,'sha256':'f'*64};self.source=[{'path':v,'bytes':1,'sha256':'e'*64}for v in sorted(p.SOURCE_PATHS|{'zig/bench/paired_linux_postgres.py','zig/bench/paired_linux_reuse.py','zig/bench/paired_linux_platform_test.py'})]
 def value(self,role='relayer',mode='ReleaseSafe'):return handoff_fixture(role,mode,self.products,self.manifest,'b'*40,self.source)
 def check(self,value):return proof.validate_handoff(value,value['role'],value['mode'],self.products,self.manifest,'b'*40,self.source,['sse2'])
 def request(self):
  value={k:None for k in p.FIELDS};value.update(schema=1,kind='paired-linux-ci-v1',root_approved=False,inputs_enabled=False,functional_enabled=False,runtime_enabled=False,handoff_enabled=False,producer_source_commit='b'*40,baseline_source_commit=p.BASELINE,baseline_profile=p.LEGACY_PROFILE,transport_requests={mode:None for mode in p.MODES});return value
 def admitted_request(self,value):
  path=self.root/'request.json';path.write_text(json.dumps(value));return p.request(path,p.pin(path)['sha256'],self.repo)
 def test_all_six_actual_phase_shapes_have_distinct_functional_scope(self):
  for role,mode in itertools.product(['relayer','validator','scraper'],p.MODES):
   with self.subTest(role=role,mode=mode):self.assertEqual(self.check(self.value(role,mode))['actual_daemon_order'],['rust','zig','rust'])
 def test_overlap_force_timeout_missing_drain_products_and_reinitialization_refuse(self):
  mutations=[('overlap',lambda v:v['epochs'][1].update(started_monotonic=30)),('forced',lambda v:v['epochs'][2]['parent_wait'].update(forced=True)),('failed_Rust',lambda v:v['epochs'][2]['parent_wait'].update(exit_code=1)),('no_wait',lambda v:v['epochs'][2]['parent_wait'].update(completed=False)),('no_drain',lambda v:v['epochs'][1].update(drained_monotonic=None)),('wrong_product',lambda v:v['epochs'][1].update(binary_sha256='0'*64)),('reset',lambda v:v['epochs'][1].update(store_initialized=True)),('replaced_store',lambda v:v['epochs'][2].update(store_identity=['another',1])),('wrong_epoch',lambda v:v['epochs'][2].update(implementation='zig')),('counterfeit_parent',lambda v:v['actual_role_launches'][2].update(actual_parent_wait=False))]
  for role in ['relayer','validator','scraper']:
   for label,mutate in mutations:
    value=self.value(role);mutate(value)
    with self.subTest(role=role,label=label),self.assertRaises(RuntimeError):self.check(value)
 def test_new_event_and_role_specific_drains_cannot_be_borrowed(self):
  mutations={'relayer':[lambda v:v['epochs'][2].update(new_event=v['epochs'][0]['new_event']),lambda v:v['epochs'][2].update(retirement_ns=v['epochs'][2]['inclusion_ns']+599*10**9),lambda v:v['epochs'][2]['settlement']['queues'].update(confirmation=1),lambda v:v['epochs'][2]['canonical_rows'][-1].update(processed=False),lambda v:v['epochs'][2].update(nonce_before=[999,0])],'validator':[lambda v:v['epochs'][2].update(signature_count_verified=2),lambda v:v['epochs'][1]['metadata'].update(git_sha='0'*40),lambda v:v['epochs'][2].update(nonce_after=2),lambda v:v['epochs'][2].update(actual_URI_in_chain_reply=False),lambda v:v['epochs'][2].update(prior_objects_after={})],'scraper':[lambda v:v['epochs'][2]['row_counts'].update(messages=2),lambda v:v['epochs'][2]['row_counts'].update(duplicate_rows_by_message_identity=1),lambda v:v['epochs'][2]['row_counts'].update(head='0|10|10|10|f|f'),lambda v:v['epochs'][2].update(prior_rows_after={}),lambda v:v['epochs'][2].update(migrations='20')]}
  for role,rows in mutations.items():
   for index,mutate in enumerate(rows):
    value=self.value(role);mutate(value)
    with self.subTest(role=role,index=index),self.assertRaises(RuntimeError):self.check(value)
 def test_actual_companion_force_failure_missing_or_other_product_refuses(self):
  for change in [lambda v:v['actual_role_launches'][-1].update(exit_code=-9),lambda v:v['actual_role_launches'][-1].update(exit_code=1),lambda v:v['actual_role_launches'].pop(),lambda v:v['actual_role_launches'][-1]['binary'].update(sha256='8'*64),lambda v:v['actual_role_launches'][-1].update(actual_parent_wait=False)]:
   raw=copy.deepcopy(self.value());change(raw)
   with self.assertRaises(RuntimeError):self.check(raw)
 def test_exact_Zig_receipt_cost_and_explicit_Rust_absent_gap(self):
  for change in [lambda a:a.update(database_tokens_used=0),lambda a:a.update(receipt_tokens_used=1),lambda a:a.update(exact_expenditure=False),lambda a:a.update(preserved_Rust_absent_record_Source_gap=True),lambda a:a.update(process_event_proof={'status':'0x1','process_ids':[]})]:
   value=self.value();change(value['epochs'][1]['accounting'])
   with self.assertRaises(RuntimeError):self.check(value)
  value=self.value();row=value['epochs'][2];row['canonical_rows'][-1].update(gas_expenditure_record_present=False,spent={'gas_used':'0','tokens_used':'0'});row['accounting'].update(database_gas_used=0,database_tokens_used=0,gas_expenditure_record_present=False,preserved_Rust_absent_record_Source_gap=True,exact_expenditure=False);self.check(value)
 def test_wrong_once_Source_baseline_mode_or_performance_claim_refuses(self):
  for name,value in [('producer_source_commit','0'*40),('baseline_source_commit','0'*40),('source_pins',[]),('performance_credit',True),('execution_source_commit',None),('input_manifest',{'bytes':1,'sha256':'0'*64})]:
   raw=self.value();raw[name]=value
   with self.subTest(field=name),self.assertRaises(RuntimeError):self.check(raw)
  raw=self.value();self.assertRaises(RuntimeError,proof.validate_handoff,raw,'validator','ReleaseSafe',self.products,self.manifest,'b'*40,self.source,['sse2']);self.assertRaises(RuntimeError,proof.validate_handoff,raw,'relayer','ReleaseFast',self.products,self.manifest,'b'*40,self.source,['sse2'])
 def test_false_handoff_never_admits_products_or_extra_Source(self):
  with mock.patch.object(p,'checked',side_effect=AssertionError('product or PG reached')),mock.patch.object(p,'load_source',side_effect=AssertionError('import reached')):
   value,_=self.admitted_request(self.request());self.assertFalse(value['handoff_enabled'])
   raw=self.request();raw['handoff_postgres_source']={'path':'anything'}
   with self.assertRaises(p.Refused):self.admitted_request(raw)
 def test_exact_extra_PG_binding_required_before_import_or_Docker(self):
  raw=self.request();raw.update(root_approved=True,handoff_enabled=True,prepared_inputs={'not':'admitted yet'})
  for bad in [None,{},False,{'path':'zig/bench/ambient_pg.py','bytes':1,'sha256':'0'*64}]:
   raw['handoff_postgres_source']=bad
   with self.subTest(value=bad),mock.patch.object(p,'load_source',side_effect=AssertionError('import reached')),self.assertRaises(p.Refused):self.admitted_request(raw)
  target=self.repo/'zig/bench/paired_linux_postgres.py';target.parent.mkdir(parents=True);target.write_bytes(b'public PG Source fixture');row={**p.pin(target),'path':'zig/bench/paired_linux_postgres.py'}
  for changed in [dict(row,bytes=row['bytes']+1),dict(row,sha256='0'*64)]:
   raw['handoff_postgres_source']=changed
   with self.subTest(value=changed),self.assertRaises(p.Refused):self.admitted_request(raw)
  other=self.root/'pg-real.py';other.write_bytes(target.read_bytes());target.unlink();target.symlink_to(other);raw['handoff_postgres_source']=row
  with self.assertRaises(p.Refused):self.admitted_request(raw)



class DefaultUtilityGraphCoverage(unittest.TestCase):
 def test_default_complete_targets_follow_tests_in_all_existing_unit_modes(self):
  text=(Path(p.__file__).resolve().parents[2]/'.github/workflows/zig-agents.yml').read_text();unit=text.split('\n  unit:\n',1)[1].split('\n  evm:\n',1)[0]
  self.assertIn('os: [ubuntu-latest, macos-15]',unit);self.assertIn('mode: [ReleaseSafe, ReleaseFast]',unit);self.assertIn('    timeout-minutes: 30',unit)
  self.assertLess(unit.index('zig.py build test '),unit.index('name: Build complete default utility targets'))
  block=unit.split('name: Build complete default utility targets',1)[1];self.assertIn('timeout-minutes: 10',block);self.assertIn('build -Dtarget=native -Dcpu=baseline -j"${BUILD_JOBS}" -Doptimize=${{ matrix.mode }} --summary all',block)
  self.assertNotIn('native-db',block);self.assertNotIn('aleo-vm-worker',block);self.assertIn('Xcode_16.3.app',unit);self.assertIn('HYPERLANE_ZIG_SDKROOT',unit)
 def test_missing_duplicate_or_test_only_build_does_not_close_graph_regression(self):
  text=(Path(p.__file__).resolve().parents[2]/'.github/workflows/zig-agents.yml').read_text();step='      - name: Build complete default utility targets\n        timeout-minutes: 10\n        run: python3 zig/tools/zig.py build -Dtarget=native -Dcpu=baseline -j"${BUILD_JOBS}" -Doptimize=${{ matrix.mode }} --summary all\n'
  for bad in [text.replace(step,'',1),text+step,text.replace('name: Build complete default utility targets','name: Build utility test only',1)]:
   with self.assertRaises(AssertionError):default_utility_workflow_inverse(bad)


class PreparedHandoffRouteControls(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir()
  current=[]
  for name in sorted(p.SOURCE_PATHS|{'zig/bench/paired_linux_platform_test.py','zig/bench/paired_linux_reuse.py'}):
   target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((ROOT/name).read_bytes()if name=='zig/bench/paired_linux_reuse.py'else b'# controlled Source\n');current.append({**p.pin(target),'path':name})
  original=[copy.deepcopy(r)for r in current if r['path']!='zig/bench/paired_linux_reuse.py'];workflow=next(r for r in current if r['path']=='.github/workflows/zig-agents.yml');old=next(r for r in original if r['path']==workflow['path'])
  origin={'run_id':42,'run_attempt':1,'source_commit':'a'*40,'job_id':100,'job_name':'paired-linux-inputs'}
  self.header={'schema':1,'kind':'paired-linux-reuse-v1','root_approved':True,'Root_input_accepted':True,'Root_six_accepted':True,'producer_source_commit':'b'*40,'baseline_source_commit':p.BASELINE,'origin':origin,'original_request':{'path':'zig/bench/paired_linux_request.json','bytes':1,'sha256':'f'*64},'original_source':original,'input_artifact':{'id':200,'name':'paired-linux-inputs-42-1','size_in_bytes':123,'sha256':'c'*64},'input_manifest':{'member':'input-manifest.json','bytes':100,'sha256':'1'*64},'proofs':[{'index':i,'mode':p.MODES[i//3],'kind':p.KINDS[i%3],'origin':{**origin,'job_id':101+i,'job_name':f'paired-linux-functional ({i})'},'artifact':{'id':201+i,'name':f'paired-linux-proof-{i}-42-1','size_in_bytes':100,'sha256':'d'*64},'members':{name:{'member':f'proof-{i}/{name}.json','bytes':10,'sha256':'e'*64}for name in ['owner','worker','proof','launches','consumer']}}for i in range(6)],'current_source':current,'workflow_recipe_delta':{'original':old,'current':workflow}}
  by={r['path']:r for r in current};self.authority={'root_approved':True,'handoff_enabled':True,'inputs_enabled':False,'functional_enabled':False,'runtime_enabled':False,'producer_source_commit':'b'*40,'baseline_source_commit':p.BASELINE,'required_source':[r for r in current if r['path']in p.SOURCE_PATHS],'handoff_reuse_source':by['zig/bench/paired_linux_reuse.py'],'handoff_port8_source':by['zig/bench/paired_linux_platform_test.py']};self.save()
  self.args=N(repo=self.repo,output=self.root/'stage',prepared_handoff=True,input_run_id=None,input_run_attempt=None,input_source_commit=None,manifest_sha256=None)
 def save(self):
  path=self.repo/'prepared-header.json';path.write_text(json.dumps(self.header));self.authority['prepared_inputs']={**p.pin(path),'path':path.name}
 def run_stage(self):
  actual=p.load_source;calls=[]
  def checked_reader(*args):
   module=actual(*args)
   def reuse(*args):
    calls.append(args);return {'enabled':True,'inputs_root':str(self.args.output/'published'),'accepted_six':{'path':'actual-retained-six'},'provenance':{'input_rebuilt':False,'native_or_timing_acceptance':False}}
   module.reuse=reuse;return module
  with mock.patch.object(p,'load_source',side_effect=checked_reader):result=stage.prepared_handoff(self.args,self.authority,Path('/exact/gh'),'synthetic-token','c'*40)
  return result,calls
 def test_relative_Root_header_reaches_unchanged_checked_reuse_API_with_current_Source(self):
  result,calls=self.run_stage();self.assertTrue(result['enabled']);self.assertEqual(len(calls),1);self.assertEqual(calls[0],(p.pin(self.repo/'prepared-header.json'),self.repo,self.args.output,'c'*40,Path('/exact/gh'),'synthetic-token'));self.assertFalse(self.args.output.exists())
 def test_missing_false_other_cohort_or_unauthenticated_header_refuses_before_fetch(self):
  for mutate in [lambda v:v.update(root_approved=False),lambda v:v.update(Root_six_accepted=False),lambda v:v.update(producer_source_commit='d'*40),lambda v:v.update(current_source=v['current_source'][:-1])]:
   old=copy.deepcopy(self.header);mutate(self.header);self.save()
   with self.assertRaises(p.Refused):self.run_stage()
   self.header=old;self.save()
  self.authority['prepared_inputs']=None
  with self.assertRaises(p.Refused):self.run_stage()
 def test_reuse_port8_hash_link_and_same_run_arguments_refuse_before_fetch(self):
  for field in ['handoff_reuse_source','handoff_port8_source']:
   row=self.authority[field];self.authority[field]={**row,'sha256':'0'*64}
   with mock.patch.object(p,'load_source',side_effect=AssertionError('unchecked import')),self.assertRaises(p.Refused):self.run_stage()
   self.authority[field]=row
   target=self.repo/row['path'];wire=target.read_bytes();other=self.root/'other';other.write_bytes(wire);target.unlink();target.symlink_to(other)
   with self.assertRaises(p.Refused):self.run_stage()
   target.unlink();target.write_bytes(wire)
  for name,value in [('input_run_id',42),('input_run_attempt',1),('input_source_commit','a'*40),('manifest_sha256','f'*64)]:
   setattr(self.args,name,value)
   with mock.patch.object(p,'handoff_reuse',side_effect=AssertionError('mixed branch imported')),self.assertRaises(p.Refused):self.run_stage()
   setattr(self.args,name,None)
 def test_real_main_and_workflow_select_prepared_branch_before_same_run_fetch(self):
  source=Path(stage.__file__).read_text();self.assertLess(source.index('if args.prepared_handoff:'),source.index('args.output.mkdir(mode=0o700)'));self.assertIn('prepared_handoff(args,authority',source)
  text=(Path(p.__file__).resolve().parents[2]/'.github/workflows/zig-agents.yml').read_text();self.assertIn("if [ '${{ matrix.phase }}' = handoff ]; then\n            python3 -I -B zig/bench/paired_linux_stage.py",text);branch=text.split('            --prepared-handoff',1)[1].split('          else',1)[0];self.assertNotIn('--input-run-id',branch);self.assertNotIn('--manifest-sha256',branch);self.assertIn('paired-linux-functional',text)


class HandoffActualProxyInterfaceControls(unittest.TestCase):
 def test_whole_role_signed_raw_capture_uses_existing_hash_verifier(self):
  import threading,collections
  role=ast.parse((Path(p.__file__).with_name('relayer.py')).read_bytes());proxy=copy.deepcopy(next(n for n in role.body if isinstance(n,ast.ClassDef)and n.name=='CountingProxy'));proxy.body=[n for n in proxy.body if isinstance(n,ast.FunctionDef)and n.name in {'__init__','signed_transactions'}]
  helper=copy.deepcopy(next(n for n in role.body if isinstance(n,ast.FunctionDef)and n.name=='_handoff_message_transaction'))
  rpc=ast.parse((ROOT/'zig/integration/relayer_process.py').read_bytes());verify=copy.deepcopy(next(n for n in rpc.body if isinstance(n,ast.FunctionDef)and n.name=='message_transaction'));namespace={};exec(compile(ast.Module(body=[verify],type_ignores=[]),'actual-rp-hash-verifier','exec'),namespace)
  hashes={'0xraw-old':'0x'+'a'*64,'0xraw-new':'0x'+'b'*64};calls=[]
  def run(command):calls.append(command);return hashes[command[2]]
  chain=N(rpc=lambda method,args:{'hash':args[0],'blockNumber':'0x1','input':'0x1234'if args[0]==hashes['0xraw-new']else'0x0000'})
  scope={'threading':threading,'collections':collections,'evm':N(run=run),'relayer_process':N(message_transaction=namespace['message_transaction'])};exec(compile(ast.Module(body=[proxy,helper],type_ignores=[]),'actual-whole-role-handoff-interface','exec'),scope)
  capture=scope['CountingProxy']('unused','anvil-1');capture.signed=['0xraw-old','0xraw-new','0xraw-new'];self.assertFalse(hasattr(capture,'raw_transactions'));result=scope['_handoff_message_transaction'](chain,capture,{'wire':'1234'});self.assertEqual(result['hash'],hashes['0xraw-new']);self.assertEqual(calls,[['cast','keccak','0xraw-old'],['cast','keccak','0xraw-new']])
  with self.assertRaises(AssertionError):scope['_handoff_message_transaction'](chain,capture,{'wire':'missing'})
  canonical=copy.deepcopy(next(n for n in rpc.body if isinstance(n,ast.FunctionDef)and n.name=='canonical_receipt'));exec(compile(ast.Module(body=[canonical],type_ignores=[]),'actual-canonical-receipt','exec'),namespace)
  chain.receipt=lambda identity:None
  with self.assertRaises(TypeError):namespace['canonical_receipt'](chain,result)
  transaction={**result,'blockHash':'0x'+'c'*64};receipt={'transactionHash':result['hash'],'blockHash':transaction['blockHash'],'blockNumber':'0x1'};chain.receipt=lambda identity:receipt;chain.rpc=lambda method,args:{'hash':transaction['blockHash'],'number':'0x1'};self.assertEqual(namespace['canonical_receipt'](chain,transaction)[0],receipt)
  chain.rpc=lambda method,args:{'hash':'0x'+'f'*64,'number':'0x1'}
  with self.assertRaises(AssertionError):namespace['canonical_receipt'](chain,transaction)


class ValidatorActualReadinessInterfaceControls(unittest.TestCase):
 def functions(self):
  import math
  role=ast.parse(Path(p.__file__).with_name('validator.py').read_bytes());helper=copy.deepcopy(next(n for n in role.body if isinstance(n,ast.FunctionDef)and n.name=='_handoff_wait_validator_ready'));rpc=ast.parse((ROOT/'zig/integration/relayer_process.py').read_bytes());parser=copy.deepcopy(next(n for n in rpc.body if isinstance(n,ast.FunctionDef)and n.name=='metric_value'));namespace={};exec(compile(ast.Module(body=[parser],type_ignores=[]),'actual-rp-metric-parser','exec'),namespace);return helper,N(metric_value=namespace['metric_value'])
 def evaluate(self,body):
  import contextlib
  helper,actual_parser=self.functions();urls=[];ticks=iter([0,0,31]);response=N(status=200,read=lambda maximum:body);urlopen=lambda url,timeout:urls.append(url)or contextlib.nullcontext(response);scope={'time':N(monotonic=lambda:next(ticks),sleep=lambda seconds:None),'urllib':N(request=N(urlopen=urlopen))};exec(compile(ast.Module(body=[helper],type_ignores=[]),'actual-validator-handoff-ready','exec'),scope)
  with mock.patch.dict(sys.modules,{'relayer_process':actual_parser}):result=scope['_handoff_wait_validator_ready'](12345,N(poll=lambda:None),100.5)
  return result,urls
 def test_actual_validator_metric_interface_freshness_and_metrics_only_endpoint(self):
  labels='data_type="merkle_tree_hook",chain="test1",task="cursor_task",agent="validator",hyperlane_baselib_version="3.0.0"';wire=('hyperlane_contract_sync_liveness{'+labels+'} 101\n').encode();ready,urls=self.evaluate(wire);self.assertEqual(ready['agent'],'validator');self.assertEqual(ready['liveness'],101);self.assertEqual(urls,['http://127.0.0.1:12345/metrics'])
  for wrong in [wire.replace(b'agent="validator"',b'agent="relayer"'),wire.replace(b' 101',b' 99'),wire.replace(b'merkle_tree_hook',b'dispatched_messages'),b'']:
   with self.assertRaisesRegex(RuntimeError,'FreshValidatorCycleTimeout'):self.evaluate(wrong)
  source=Path(p.__file__).with_name('validator.py').read_text();self.assertNotIn('relayer_process.wait_role_ready',source);self.assertNotIn('/list_operations',source)
 def test_actual_Rust_first_event_is_seeded_before_cursor_readiness(self):
  tree=ast.parse(Path(p.__file__).with_name('validator.py').read_bytes());function=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='run_drained_handoff');loop=next(n for n in ast.walk(function)if isinstance(n,ast.For)and isinstance(n.target,ast.Tuple)and any(isinstance(t,ast.Name)and t.id=='implementation'for t in n.target.elts));seed=[n for n in ast.walk(function)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='dispatch'and len(n.args)==1 and isinstance(n.args[0],ast.Constant)and n.args[0].value==0];self.assertEqual(len(seed),1);self.assertLess(seed[0].lineno,loop.lineno)
  ready=next(n for n in ast.walk(loop)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='_handoff_wait_validator_ready');later=next(n for n in loop.body if isinstance(n,ast.If)and isinstance(n.test,ast.Name)and n.test.id=='number'and any(isinstance(x,ast.Call)and isinstance(x.func,ast.Name)and x.func.id=='dispatch'for x in ast.walk(n)));self.assertLess(ready.lineno,later.lineno);dispatches=[n for n in ast.walk(function)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='dispatch'];self.assertEqual(len(dispatches),2)
 def test_actual_new_fixture_forced_shutdown_cleans_up_and_refuses_success(self):
  import subprocess
  tree=ast.parse(Path(p.__file__).with_name('validator.py').read_bytes());function=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='run_drained_handoff');boundary=next(n for n in ast.walk(function)if isinstance(n,ast.Try)and n.finalbody and any(isinstance(call,ast.Call)and isinstance(call.func,ast.Attribute)and isinstance(call.func.value,ast.Name)and call.func.value.id=='anvil'and call.func.attr=='terminate'for statement in n.finalbody for call in ast.walk(statement)));code=compile(ast.Module(body=copy.deepcopy(boundary.finalbody[-2:]),type_ignores=[]),'actual-new-fixture-shutdown','exec')
  for forced in [False,True]:
   events=[]
   def wait(timeout):
    events.append('wait')
    if forced and events.count('wait')==1:raise subprocess.TimeoutExpired('owned-fixture',timeout)
    return -15
   scope={'subprocess':subprocess,'anvil':N(terminate=lambda:events.append('terminate'),wait=wait,kill=lambda:events.append('kill'))}
   if forced:
    with self.assertRaisesRegex(RuntimeError,'ForcedFixtureShutdown'):exec(code,scope)
    self.assertEqual(events,['terminate','wait','kill','wait'])
   else:exec(code,scope);self.assertEqual(events,['terminate','wait'])
 def test_typed_readback_refuses_wrong_role_stale_or_missing_validator_cycle(self):
  controls=DrainedHandoffControls();controls.setUp();self.addCleanup(controls.doCleanups)
  for key,value in [('agent','relayer'),('data_type','dispatched_messages'),('chain','test2'),('task','tx_id_task'),('launch_unix_seconds',float('nan')),('liveness',99),('http_status',503),('metrics_bytes',0)]:
   raw=controls.value('validator');raw['epochs'][1]['readiness'][key]=value
   with self.subTest(field=key),self.assertRaises(RuntimeError):controls.check(raw)


class DrainedHandoffWorkflowInverseControls(unittest.TestCase):
 def actual_inverses(self):
  functions=[]
  for name in ['zig/bench/paired_linux_test.py','zig/tools/aleo_linux_case/ci_fullcase_test.py']:
   tree=ast.parse((ROOT/name).read_bytes());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow');scope={'hashlib':hashlib};exec(compile(ast.Module(body=[node],type_ignores=[]),'actual-self-contained-reviewed-workflow-inverse','exec'),scope);functions.append((node,scope['ordinary_native_http_workflow']))
  self.assertEqual(ast.dump(functions[0][0],include_attributes=False),ast.dump(functions[1][0],include_attributes=False));return functions
 def current(self):return(ROOT/'.github/workflows/zig-agents.yml').read_text()
 def test_both_standalone_inverses_restore_original_full_golden(self):
  for node,inverse in self.actual_inverses():
   normalized=inverse(self.current());self.assertEqual(hashlib.sha256(normalized.encode()).hexdigest(),'e08ffd005159dd3915047706df9a1806b' '13cf3344795e5700980910bc38f9ef3');self.assertNotIn('Build complete default utility targets',normalized);self.assertNotIn('handoff_enabled',normalized);self.assertNotIn('--prepared-handoff',normalized)
 def test_each_exact_hunk_missing_duplicated_or_mutated_refuses(self):
  for node,inverse in self.actual_inverses():
   hunks=[ast.literal_eval(n.value)for n in node.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='handoff_after'for t in n.targets)];self.assertEqual(len(hunks),6)
   diagnostic={n.targets[0].id:ast.literal_eval(n.value)for n in node.body if isinstance(n,ast.Assign)and len(n.targets)==1 and isinstance(n.targets[0],ast.Name)and n.targets[0].id in {'functional_diagnostics_before','functional_diagnostics_after'}}
   hunks=[h.replace(diagnostic['functional_diagnostics_before'],diagnostic['functional_diagnostics_after'],1)for h in hunks]
   for index,hunk in enumerate(hunks):
    for changed in [self.current().replace(hunk,'',1),self.current()+hunk,self.current().replace(hunk,'UNREVIEWED'+hunk[1:],1)]:
     with self.subTest(hunk=index),self.assertRaisesRegex(AssertionError,'reviewed utility/handoff workflow hunk|Exact functional diagnostic uploads required'):inverse(changed)
 def test_unreviewed_parallel_timeout_and_workflow_recipe_changes_still_fail_golden(self):
  text=self.current();functional=text.split('\n  paired-linux-functional:',1)[1].split('\n  paired-linux-runtime:',1)[0]
  for changed_body in [functional.replace('      max-parallel: 2','      max-parallel: 3',1),functional.replace('timeout-minutes: 180','timeout-minutes: 181',1),functional.replace('timeout-minutes: 122','timeout-minutes: 123',1)]:
   self.assertNotEqual(changed_body,functional);changed=text.replace(functional,changed_body,1)
   for node,inverse in self.actual_inverses():
    with self.assertRaises(AssertionError):self.assertEqual(hashlib.sha256(inverse(changed).encode()).hexdigest(),'e08ffd005159dd3915047706df9a1806b' '13cf3344795e5700980910bc38f9ef3')


class PublicProofBudgetControls(unittest.TestCase):
 def test_only_public_proof_gets_larger_typed_budget_metadata_unchanged(self):
  self.assertEqual(p.proof_limits('public_relay_process'),(128*1024**2,8*1024**2))
  for kind in ['relayer_process','relayer_stream']:self.assertEqual(p.proof_limits(kind),(64*1024**2,2000000))
  for kind in [None,True,'public','runtime']:
   with self.assertRaises(p.Refused):p.proof_limits(kind)
  with self.assertRaises(p.Refused):p.decode(b' '*(32*1024**2+1))
 def test_public_bytes_above_old_cap_preserve_full_response_other_kinds_refuse(self):
  raw=b'{"response":"'+b'x'*(64*1024**2)+b'"}'
  self.assertEqual(len(p.decode_proof(raw,'public_relay_process')['response']),64*1024**2)
  for kind in ['relayer_process','relayer_stream']:
   with self.assertRaises(p.Refused):p.decode_proof(raw,kind)
  del raw
  with self.assertRaises(p.Refused):p.decode_proof(b' '*(128*1024**2+1),'public_relay_process')
 def test_public_actual_parser_nodes_above_old_cap_other_kinds_refuse(self):
  raw=b'{"observations":['+b'0,'*2000000+b'0]}'
  self.assertEqual(len(p.decode_proof(raw,'public_relay_process')['observations']),2000001)
  for kind in ['relayer_process','relayer_stream']:
   with self.assertRaises(p.Refused):p.decode_proof(raw,kind)
  with mock.patch.object(p,'decode',return_value={'observations':[]})as decode:
   p.decode_proof(b'{}','public_relay_process');decode.assert_called_once_with(b'{}',128*1024**2,8*1024**2)
 def test_parent_final_sample_after_completed_worker_refuses_all_original_bounds(self):
  import contextlib
  import paired_linux_owner as owner
  for case in ['ok','peak','late','disk','free']:
   with self.subTest(case=case),tempfile.TemporaryDirectory()as directory:
    root=Path(directory).resolve();repo=root/'repo';repo.mkdir();args=N(phase='functional',request=root/'request',request_sha256='a'*64,repo=repo,inputs=root/'inputs',index=2,output=root/'output');after={'worker':False};child=N(pid=123);custody=mock.Mock();custody.allocated.side_effect=lambda path:512*1024**2+1 if after['worker']and case=='disk'else 0;custody.processes.return_value={};custody.owned_processes.return_value={123:{'rss_bytes':1}};custody.stop_owned.return_value={'actual_parent_wait':True,'exit_code':0,'clean':True,'signals':[],'errors':[]}
    def completed(*ignored):after['worker']=True;return {'path':'synthetic-worker','bytes':1,'sha256':'b'*64}
    usage=mock.Mock(side_effect=lambda who:N(ru_maxrss=(4*1024**3+1024)//1024 if after['worker']and case=='peak'else 1))
    with contextlib.ExitStack()as stack:
     for target,name,replacement in [(owner.policy,'request',mock.Mock(return_value=({'root_approved':True,'functional_enabled':True},{'sha256':'a'*64}))),(owner.policy,'load_source',mock.Mock(return_value=custody)),(owner,'completed_worker',mock.Mock(side_effect=completed)),(owner.sys,'platform','linux'),(owner.os,'pidfd_open',mock.Mock()),(owner.signal,'pidfd_send_signal',mock.Mock()),(owner.signal,'getsignal',mock.Mock(return_value=0)),(owner.signal,'signal',mock.Mock()),(owner.signal,'pthread_sigmask',mock.Mock(return_value=set())),(owner.shutil,'disk_usage',mock.Mock(side_effect=lambda path:N(free=(5 if after['worker']and case=='free'else 7)*1024**3))),(owner.subprocess,'Popen',mock.Mock(return_value=child)),(owner.os,'waitid',mock.Mock(return_value=N())),(owner.time,'monotonic',mock.Mock(side_effect=lambda:7301 if after['worker']and case=='late'else 100)),(owner.resource,'getrusage',usage)]:stack.enter_context(mock.patch.object(target,name,replacement,create=True))
     if case=='ok':owner.owner(args)
     else:
      with self.assertRaises(p.Refused):owner.owner(args)
    row=json.loads((args.output/'owner-result.json').read_bytes());self.assertEqual(row['passed'],case=='ok');self.assertIsNotNone(row['worker_receipt']);self.assertIsNotNone(row['parent_final_resource_sample']);usage.assert_called_once_with(owner.resource.RUSAGE_SELF);custody.stop_owned.assert_called_once()
    if case=='peak':self.assertGreater(row['sampled_tree_RSS_peak_bytes'],4*1024**3)
    if case!='ok':self.assertEqual(row['error_type'],'FinalResourceRefused')

if __name__=='__main__':unittest.main()
