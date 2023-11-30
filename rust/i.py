import os
import sys
import argparse
import subprocess
import platform
import random
import textwrap
import urllib.request as urlrq
import ssl
import json
import tempfile
from enum import Enum

DEFAULT_OSMOSIS_HOME = os.path.expanduser("~/.osmosisd")
DEFAULT_MONIKER = "osmosis"

NETWORK_CHOICES = ['osmosis-1', 'osmo-test-5']
INSTALL_CHOICES = ['node', 'client', 'localosmosis']
PRUNING_CHOICES = ['default', 'nothing', 'everything']

# CLI arguments
parser = argparse.ArgumentParser(description="Osmosis Installer")

parser.add_argument(
    "--home",
    type=str,
    help=f"Osmosis installation location",
)

parser.add_argument(
    '-m',
    "--moniker",
    type=str,
    help="Moniker name for the node (Default: 'osmosis')",
)

parser.add_argument(
    '-v',
    '--verbose',
    action='store_true',
    help="Enable verbose output",
    dest="verbose"
)

parser.add_argument(
    '-o',
    '--overwrite',
    action='store_true',
    help="Overwrite existing Osmosis home without prompt",
    dest="overwrite"
)

parser.add_argument(
    '-n',
    '--network',
    type=str,
    choices=NETWORK_CHOICES,
    help=f"Network to join: {NETWORK_CHOICES})",
)

parser.add_argument(
    '-p',
    '--pruning',
    type=str,
    choices=PRUNING_CHOICES,
    help=f"Pruning settings: {PRUNING_CHOICES})",
)

parser.add_argument(
    '-i',
    '--install',
    type=str,
    choices=INSTALL_CHOICES,
    help=f"Which installation to do: {INSTALL_CHOICES})",
)

parser.add_argument(
    "--binary_path",
    type=str,
    help=f"Path where to download the binary",
    default="/usr/local/bin"
)

parser.add_argument(
    '-c',
    '--cosmovisor',
    action='store_true',
    help="Install cosmovisor"
)

parser.add_argument(
    '-s',
    '--service',
    action='store_true',
    help="Setup systemd service (Linux only)"
)

args = parser.parse_args()

# Choices
class InstallChoice(str, Enum):
    NODE = "1"
    CLIENT = "2"
    LOCALOSMOSIS = "3"

class NetworkChoice(str, Enum):
    MAINNET = "1"
    TESTNET = "2"

class PruningChoice(str, Enum):
    DEFAULT = "1"
    NOTHING = "2"
    EVERYTHING = "3"

class Answer(str, Enum):
    YES = "1"
    NO = "2"

# Network configurations
class Network:
    def __init__(self, chain_id, version, genesis_url, binary_url, peers, rpc_node, addrbook_url, snapshot_url):
        self.chain_id = chain_id
        self.version = version
        self.genesis_url = genesis_url
        self.binary_url = binary_url
        self.peers = peers
        self.rpc_node = rpc_node
        self.addrbook_url = addrbook_url
        self.snapshot_url = snapshot_url

TESTNET = Network(
    chain_id = "osmo-test-5",
    version = "v20.1.0-testnet",
    genesis_url = "https://osmosis.fra1.digitaloceanspaces.com/osmo-test-5/genesis.json",
    binary_url = {
        "linux": {
            "amd64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/v20.1.0-testnet/osmosisd-20.1.0-testnet-linux-amd64",
            "arm64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/v20.1.0-testnet/osmosisd-20.1.0-testnet-linux-arm64"
        },
        "darwin": {
            "amd64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/v20.1.0-testnet/osmosisd-20.1.0-testnet-darwin-amd64",
            "arm64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/v20.1.0-testnet/osmosisd-20.1.0-testnet-darwin-arm64"
        },
    },
    peers = [
        "a5f81c035ff4f985d5e7c940c7c3b846389b7374@167.235.115.14:26656",
        "05c41cc1fc7c8cb379e54d784bcd3b3907a1568e@157.245.26.231:26656",
        "7c2b9e76be5c2142c76b429d9c29e902599ceb44@157.245.21.183:26656",
        "f440c4980357d8b56db87ddd50f06bd551f1319a@5.78.98.19:26656",
        "ade4d8bc,8cbe014af6ebdf3cb7b1e9ad36f412c0@testnet-seeds.polkachu.com:12556",
    ],
    rpc_node = "https://rpc.testnet.osmosis.zone:443",
    addrbook_url = "https://rpc.testnet.osmosis.zone/addrbook",
    snapshot_url = "https://snapshots.testnet.osmosis.zone/latest"
)

MAINNET = Network(
    chain_id = "osmosis-1",
    version = "v20.2.1",
    genesis_url = "https://osmosis.fra1.digitaloceanspaces.com/osmosis-1/genesis.json",
    binary_url = {
        "linux": {
            "amd64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/v20.2.1/osmosisd-20.2.1-linux-amd64",
            "arm64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/v20.2.1/osmosisd-20.2.1-linux-arm64"
        },
        "darwin": {
            "amd64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/v20.2.1/osmosisd-20.2.1-darwin-amd64",
            "arm64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/v20.2.1/osmosisd-20.2.1-darwin-arm64"
        },
    },
    peers = None,
    rpc_node = "https://rpc.osmosis.zone:443",
    addrbook_url = "https://rpc.osmosis.zone/addrbook",
    snapshot_url = "https://snapshots.osmosis.zone/latest"
)

COSMOVISOR_URL = {
    "darwin": {
        "amd64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/cosmovisor/cosmovisor-v1.2.0-darwin-amd64",
        "arm64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/cosmovisor/cosmovisor-v1.2.0-darwin-arm64"
    },
    "linux": {
        "amd64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/cosmovisor/cosmovisor-v1.2.0-linux-amd64",
        "arm64": "https://osmosis.fra1.digitaloceanspaces.com/binaries/cosmovisor/cosmovisor-v1.2.0-linux-arm64"
    }
}
# Terminal utils

class bcolors:
    OKGREEN = '\033[92m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    PURPLE = '\033[95m'

def clear_screen():
    os.system('clear')

# Messages

def welcome_message():
    print(bcolors.OKGREEN + """
 ██████╗ ███████╗███╗   ███╗ ██████╗ ███████╗██╗███████╗
██╔═══██╗██╔════╝████╗ ████║██╔═══██╗██╔════╝██║██╔════╝
██║   ██║███████╗██╔████╔██║██║   ██║███████╗██║███████╗
██║   ██║╚════██║██║╚██╔╝██║██║   ██║╚════██║██║╚════██║
╚██████╔╝███████║██║ ╚═╝ ██║╚██████╔╝███████║██║███████║
╚═════╝ ╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚═╝╚══════╝

Welcome to the Osmosis node installer!


For more information, please visit https://docs.osmosis.zone

If you have an old Osmosis installation, 
- backup any important data before proceeding
- ensure that no osmosis services are running in the background
""" + bcolors.ENDC)


def client_complete_message(osmosis_home):
    print(bcolors.OKGREEN + """
✨ Congratulations! You have successfully completed setting up an Osmosis client! ✨
""" + bcolors.ENDC)

    print("🧪 Try running: " + bcolors.OKGREEN + f"osmosisd status --home {osmosis_home}" + bcolors.ENDC)
    print()


def node_complete_message(using_cosmovisor, using_service, osmosis_home):
    print(bcolors.OKGREEN + """
✨ Congratulations! You have successfully completed setting up an Osmosis node! ✨
""" + bcolors.ENDC)
    
    if using_service:

        if using_cosmovisor:
            print("🧪 To start the cosmovisor service run: ")
            print(bcolors.OKGREEN + f"sudo systemctl start cosmovisor" + bcolors.ENDC)
        else:
            print("🧪 To start the osmosisd service run: ")
            print(bcolors.OKGREEN + f"sudo systemctl start osmosisd" + bcolors.ENDC)

    else:
        if using_cosmovisor:
            print("🧪 To start cosmovisor run: ")
            print(bcolors.OKGREEN + f"DAEMON_NAME=osmosisd DAEMON_HOME={osmosis_home} cosmovisor run start" + bcolors.ENDC)
        else:
            print("🧪 To start osmosisd run: ")
            print(bcolors.OKGREEN + f"osmosisd start --home {osmosis_home}" + bcolors.ENDC)


    
    print()

# Options

def select_install():

    # Check if setup is specified in args
    if args.install:
        if args.install == "node":
            choice = InstallChoice.NODE
        elif args.install == "client":
            choice = InstallChoice.CLIENT
        elif args.install ==  "localosmosis":
            choice = InstallChoice.LOCALOSMOSIS
        else:
            print(bcolors.RED + f"Invalid setup {args.install}. Please choose a valid setup.\n" + bcolors.ENDC)
            sys.exit(1)
    
    else:

        print(bcolors.OKGREEN + """
Please choose the desired installation:

    1) node         - run an osmosis node and join mainnet or testnet
    2) client       - setup osmosisd to query a public node
    3) localosmosis - setup a local osmosis development node

💡 You can select the installation using the --install flag.
        """ + bcolors.ENDC)

        while True:
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice not in [InstallChoice.NODE, InstallChoice.CLIENT, InstallChoice.LOCALOSMOSIS]:
                print("Invalid input. Please choose a valid option.")
            else:
                break
            
        if args.verbose:
            clear_screen()
            print(f"Chosen install: {INSTALL_CHOICES[int(choice) - 1]}")

    clear_screen()
    return choice


def select_network():
    """
    Selects a network based on user input or command-line arguments.

    Returns:
        chosen_network (NetworkChoice): The chosen network, either MAINNET or TESTNET.

    Raises:
        SystemExit: If an invalid network is specified or the user chooses to exit the program.
    """

    # Check if network is specified in args
    if args.network:
        if args.network == MAINNET.chain_id:
            choice = NetworkChoice.MAINNET
        elif args.network == TESTNET.chain_id:
            choice = NetworkChoice.TESTNET
        else:
            print(bcolors.RED + f"Invalid network {args.network}. Please choose a valid network." + bcolors.ENDC)
            sys.exit(1)

    # If not, ask the user to choose a network
    else:
        print(bcolors.OKGREEN + f"""
Please choose the desired network:

    1) Mainnet ({MAINNET.chain_id})
    2) Testnet ({TESTNET.chain_id})

💡 You can select the network using the --network flag.
""" + bcolors.ENDC)

        while True:
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice not in [NetworkChoice.MAINNET, NetworkChoice.TESTNET]:
                print(bcolors.RED + "Invalid input. Please choose a valid option. Accepted values: [ 1 , 2 ] \n" + bcolors.ENDC)
            else:
                break
        
    if args.verbose:
        clear_screen()
        print(f"Chosen network: {NETWORK_CHOICES[int(choice) - 1]}")

    clear_screen()
    return choice


def select_osmosis_home():
    """
    Selects the path for running the 'osmosisd init --home <SELECTED_HOME>' command.

    Returns:
        osmosis_home (str): The selected path.

    """
    if args.home:
        osmosis_home = args.home
    else:
        default_home = os.path.expanduser("~/.osmosisd")
        print(bcolors.OKGREEN + f"""
Do you want to install Osmosis in the default location?:

    1) Yes, use default location {DEFAULT_OSMOSIS_HOME} (recommended)
    2) No, specify custom location

💡 You can specify the home using the --home flag.
""" + bcolors.ENDC)

        while True:
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice == Answer.YES:
                osmosis_home = default_home
                break

            elif choice == Answer.NO:
                while True:
                    custom_home = input("Enter the path for Osmosis home: ").strip()
                    if custom_home != "":
                        osmosis_home = custom_home
                        break
                    else:
                        print("Invalid path. Please enter a valid directory.")
                break
            else:
                print("Invalid choice. Please enter 1 or 2.")

    clear_screen()
    return osmosis_home


def select_moniker():
    """
    Selects the moniker for the Osmosis node.

    Returns:
        moniker (str): The selected moniker.

    """
    if args.moniker:
        moniker = args.moniker
    else:
        print(bcolors.OKGREEN + f"""
Do you want to use the default moniker?

    1) Yes, use default moniker ({DEFAULT_MONIKER})
    2) No, specify custom moniker

💡 You can specify the moniker using the --moniker flag.
""" + bcolors.ENDC)

        while True:
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice == Answer.YES:
                moniker = DEFAULT_MONIKER
                break
            elif choice == Answer.NO:
                while True:
                    custom_moniker = input("Enter the custom moniker: ")
                    if custom_moniker.strip() != "":
                        moniker = custom_moniker
                        break
                    else:
                        print("Invalid moniker. Please enter a valid moniker.")
                break
            else:
                print("Invalid choice. Please enter 1 or 2.")

    clear_screen()
    return moniker


def initialize_osmosis_home(osmosis_home, moniker):
    """
    Initializes the Osmosis home directory with the specified moniker.

    Args:
        osmosis_home (str): The chosen home directory.
        moniker (str): The moniker for the Osmosis node.

    """
    if not args.overwrite:

        while True:
            print(bcolors.OKGREEN + f"""
Do you want to initialize the Osmosis home directory at '{osmosis_home}'?
            """ + bcolors.ENDC, end="")

            print(bcolors.RED + f"""
⚠️ All contents of the directory will be deleted.
            """ + bcolors.ENDC, end="")

            print(bcolors.OKGREEN + f"""
    1) Yes, proceed with initialization
    2) No, quit

💡 You can overwrite the osmosis home using --overwrite flag.
            """ + bcolors.ENDC)
            
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice == Answer.YES:
                break

            elif choice == Answer.NO:
                sys.exit(0)

            else:
                print("Invalid choice. Please enter 1 or 2.")
    
    print(f"Initializing Osmosis home directory at '{osmosis_home}'...")
    try:
        subprocess.run(
            ["rm", "-rf", osmosis_home], 
            stderr=subprocess.DEVNULL, check=True)
        
        subprocess.run(
            ["osmosisd", "init", moniker,  "-o", "--home", osmosis_home], 
            stderr=subprocess.DEVNULL, check=True)

        print("Initialization completed successfully.")

    except subprocess.CalledProcessError as e:
        print("Initialization failed.")
        print("Please check if the home directory is valid and has write permissions.")
        print(e)
        sys.exit(1)

    clear_screen()


def select_pruning(osmosis_home):
    """
    Allows the user to choose pruning settings and performs actions based on the selected option.

    """

    # Check if pruning settings are specified in args
    if args.pruning:
        if args.pruning == "default":
            choice = PruningChoice.DEFAULT
        elif args.pruning == "nothing":
            choice = PruningChoice.NOTHING
        elif args.pruning ==  "everything":
            choice = PruningChoice.EVERYTHING
        else:
            print(bcolors.RED + f"Invalid pruning setting {args.pruning}. Please choose a valid setting.\n" + bcolors.ENDC)
            sys.exit(1)
    
    else:

        print(bcolors.OKGREEN + """
Please choose your desired pruning settings:

    1) Default: (keep last 100,000 states to query the last week worth of data and prune at 100 block intervals)
    2) Nothing: (keep everything, select this if running an archive node)
    3) Everything: (keep last 10,000 states and prune at a random prime block interval)

💡 You can select the pruning settings using the --pruning flag.
    """ + bcolors.ENDC)

        while True:
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice not in [PruningChoice.DEFAULT, PruningChoice.NOTHING, PruningChoice.EVERYTHING]:
                print("Invalid input. Please choose a valid option.")
            else:
                break
            
        if args.verbose:
            clear_screen()
            print(f"Chosen setting: {PRUNING_CHOICES[int(choice) - 1]}")
    
    app_toml = os.path.join(osmosis_home, "config", "app.toml")

    if choice == PruningChoice.DEFAULT:
        # Nothing to do
        pass

    elif choice == PruningChoice.NOTHING:
        subprocess.run(["sed -i -E 's/pruning = \"default\"/pruning = \"nothing\"/g' " + app_toml], shell=True)

    elif choice == PruningChoice.EVERYTHING:
        primeNum = random.choice([x for x in range(11, 97) if not [t for t in range(2, x) if not x % t]])
        subprocess.run(["sed -i -E 's/pruning = \"default\"/pruning = \"custom\"/g' " + app_toml], shell=True)
        subprocess.run(["sed -i -E 's/pruning-keep-recent = \"0\"/pruning-keep-recent = \"10000\"/g' " + app_toml], shell=True)
        subprocess.run(["sed -i -E 's/pruning-interval = \"0\"/pruning-interval = \"" + str(primeNum) + "\"/g' " + app_toml], shell=True)
    
    else:
        print(bcolors.RED + f"Invalid pruning setting {choice}. Please choose a valid setting.\n" + bcolors.ENDC)
        sys.exit(1)

    clear_screen()


def customize_config(home, network):
    """
    Customizes the TOML configurations based on the network.

    Args:
        home (str): The home directory.
        network (str): The network identifier.

    """

    # osmo-test-5 configuration
    if network == NetworkChoice.TESTNET:

        # patch client.toml
        client_toml = os.path.join(home, "config", "client.toml")

        with open(client_toml, "r") as config_file:
            lines = config_file.readlines()

        for i, line in enumerate(lines):
            if line.startswith("chain-id"):
                lines[i] = f'chain-id = "{TESTNET.chain_id}"\n'
            elif line.startswith("node"):
                lines[i] = f'node = "{TESTNET.rpc_node}"\n'

        with open(client_toml, "w") as config_file:
            config_file.writelines(lines)

        # patch config.toml
        config_toml = os.path.join(home, "config", "config.toml")
        
        peers = ','.join(TESTNET.peers)
        subprocess.run(["sed -i -E 's/persistent_peers = \"\"/persistent_peers = \"" + peers + "\"/g' " + config_toml], shell=True)
    
    # osmosis-1 configuration
    elif network == NetworkChoice.MAINNET:
        client_toml = os.path.join(home, "config", "client.toml")

        with open(client_toml, "r") as config_file:
            lines = config_file.readlines()

        for i, line in enumerate(lines):
            if line.startswith("chain-id"):
                lines[i] = f'chain-id = "{MAINNET.chain_id}"\n'
            elif line.startswith("node"):
                lines[i] = f'node = "{MAINNET.rpc_node}"\n'

        with open(client_toml, "w") as config_file:
            config_file.writelines(lines)

    else:
        print(bcolors.RED + f"Invalid network {network}. Please choose a valid setting.\n" + bcolors.ENDC)
        sys.exit(1)
    
    clear_screen()


def download_binary(network):
    """
    Downloads the binary for the specified network based on the operating system and architecture.

    Args:
        network (NetworkChoice): The network type, either MAINNET or TESTNET.

    Raises:
        SystemExit: If the binary download URL is not available for the current operating system and architecture.

    """
    operating_system = platform.system().lower()
    architecture = platform.machine()

    if architecture == "x86_64":
        architecture = "amd64"
    elif architecture == "aarch64":
        architecture = "arm64"

    if architecture not in ["arm64", "amd64"]:
        print(f"Unsupported architecture {architecture}.")
        sys.exit(1)

    if network == NetworkChoice.TESTNET:
        binary_urls = TESTNET.binary_url
    else:
        binary_urls = MAINNET.binary_url

    if operating_system in binary_urls and architecture in binary_urls[operating_system]:
        binary_url = binary_urls[operating_system][architecture]
    else:
        print(f"Binary download URL not available for {operating_system}/{architecture}")
        sys.exit(0)

    try:   
        binary_path = os.path.join(args.binary_path, "osmosisd")

        print("Downloading " + bcolors.PURPLE+ "osmosisd" + bcolors.ENDC, end="\n\n")
        print("from " + bcolors.OKGREEN + f"{binary_url}" + bcolors.ENDC, end=" ")
        print("to " + bcolors.OKGREEN + f"{binary_path}" + bcolors.ENDC)
        print()
        print(bcolors.OKGREEN + "💡 You can change the path using --binary_path" + bcolors.ENDC)

        subprocess.run(["wget", binary_url,"-q", "-O", "/tmp/osmosisd"], check=True)
        os.chmod("/tmp/osmosisd", 0o755)

        if platform.system() == "Linux":
            subprocess.run(["sudo", "mv", "/tmp/osmosisd", binary_path], check=True)
            subprocess.run(["sudo", "chown", f"{os.environ['USER']}:{os.environ['USER']}", binary_path], check=True)
            subprocess.run(["sudo", "chmod", "+x", binary_path], check=True)
        else:
            subprocess.run(["mv", "/tmp/osmosisd", binary_path], check=True)

        # Test binary 
        subprocess.run(["osmosisd", "version"], check=True)

        print("Binary downloaded successfully.")

    except subprocess.CalledProcessError as e:
        print(e)
        print("Failed to download the binary.")
        sys.exit(1)

    clear_screen()


def download_genesis(network, osmosis_home):
    """
    Downloads the genesis file for the specified network.

    Args:
        network (NetworkChoice): The network type, either MAINNET or TESTNET.
        osmosis_home (str): The path to the Osmosis home directory.

    Raises:
        SystemExit: If the genesis download URL is not available for the current network.

    """
    if network == NetworkChoice.TESTNET:
        genesis_url = TESTNET.genesis_url
    else:
        genesis_url = MAINNET.genesis_url

    if genesis_url:
        try:
            print("Downloading " + bcolors.PURPLE + "genesis.json" + bcolors.ENDC + f" from {genesis_url}")
            genesis_path = os.path.join(osmosis_home, "config", "genesis.json")

            subprocess.run(["wget", genesis_url, "-q", "-O", genesis_path], check=True)
            print("Genesis downloaded successfully.\n")

        except subprocess.CalledProcessError:
            print("Failed to download the genesis.")
            sys.exit(1)


def download_addrbook(network, osmosis_home):
    """
    Downloads the addrbook for the specified network.

    Args:
        network (NetworkChoice): The network type, either MAINNET or TESTNET.
        osmosis_home (str): The path to the Osmosis home directory.

    Raises:
        SystemExit: If the genesis download URL is not available for the current network.

    """
    if network == NetworkChoice.TESTNET:
        addrbook_url = TESTNET.addrbook_url
    else:
        addrbook_url = MAINNET.addrbook_url

    if addrbook_url:
        try:
            print("Downloading " + bcolors.PURPLE + "addrbook.json" + bcolors.ENDC + f" from {addrbook_url}")
            addrbook_path = os.path.join(osmosis_home, "config", "addrbook.json")

            subprocess.run(["wget", addrbook_url, "-q", "-O", addrbook_path], check=True)
            print("Addrbook downloaded successfully.")

        except subprocess.CalledProcessError:
            print("Failed to download the addrbook.")
            sys.exit(1)

    clear_screen()


def download_snapshot(network, osmosis_home):
    """
    Downloads the snapshot for the specified network.

    Args:
        network (NetworkChoice): The network type, either MAINNET or TESTNET.
        osmosis_home (str): The path to the Osmosis home directory.

    Raises:
        SystemExit: If the genesis download URL is not available for the current network.

    """

    def install_snapshot_prerequisites():
        """
        Installs the prerequisites: Homebrew (brew) package manager and lz4 compression library.

        Args:
            osmosis_home (str): The path of the Osmosis home directory.

        """
        while True:
            print(bcolors.OKGREEN + f"""
To download the snapshot, we need the lz4 compression library.
Do you want me to install it?

    1) Yes, install lz4
    2) No, continue without installing lz4
        """ + bcolors.ENDC)

            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice == Answer.YES:
                break

            elif choice == Answer.NO:
                clear_screen()
                return

            else:
                print("Invalid choice. Please enter 1 or 2.")

        operating_system = platform.system().lower()  
        if operating_system == "linux":
            print("Installing lz4...")
            subprocess.run(["sudo apt-get install wget liblz4-tool aria2 -y"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=True)
        else:
            print("Installing Homebrew...")
            subprocess.run(['bash', '-c', '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'])

            print("Installing lz4...")
            subprocess.run(['brew', 'install', 'lz4'])

        print("Installation completed successfully.")
        clear_screen()


    def parse_snapshot_info(network):
        """
        Creates a dictionary containing the snapshot information for the specified network.
        It merges the snapshot information from the osmosis official snapshot JSON and 
        quicksync from chianlayer https://dl2.quicksync.io/json/osmosis.json

        Returns:
            dict: Dictionary containing the parsed snapshot information.

        """
        snapshot_info = []

        if network == NetworkChoice.TESTNET:
            snapshot_url = TESTNET.snapshot_url
            chain_id = TESTNET.chain_id
            quicksync_prefix = "osmotestnet-5"
        elif network == NetworkChoice.MAINNET:
            snapshot_url = MAINNET.snapshot_url
            chain_id = MAINNET.chain_id
            quicksync_prefix = "osmosis-1"
        else:
            print(f"Invalid network choice - {network}")
            sys.exit(1)

        # Set SSL context
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

        req = urlrq.Request(snapshot_url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urlrq.urlopen(req, context=context)
        latest_snapshot_url = resp.read().decode()

        snapshot_info.append({
            "network": chain_id,
            "mirror": "Germany",
            "url": latest_snapshot_url.rstrip('\n'),
            "type": "pruned",
            "provider": "osmosis"
        })

        # Parse quicksync snapshot json
        try:
            url = "https://dl2.quicksync.io/json/osmosis.json"
            resp = urlrq.urlopen(url, context=context)
            data = resp.read().decode()

            snapshots = json.loads(data)

            for snapshot in snapshots:
                
                if not snapshot["file"].startswith(quicksync_prefix):
                    continue

                snapshot_info.append({
                    "network": chain_id,
                    "mirror": snapshot["mirror"],
                    "url": snapshot["url"],
                    "type": snapshot["network"],
                    "provider": "chainlayer"
                })

        except (urlrq.URLError, json.JSONDecodeError) as e:
            print(f"Error: Failed to fetch or parse snapshot JSON - {e}")

        return snapshot_info


    def print_snapshot_download_info(snapshot_info):
        """
        Prints the information about the snapshot download.
        """

        print(bcolors.OKGREEN + f"""
Choose one of the following snapshots:
        """ + bcolors.ENDC)

        # Prepare table headers
        column_widths = [1, 12, 12, 12]
        headers = ["#", "Provider", "Location", "Type"]
        header_row = " | ".join(f"{header:{width}}" for header, width in zip(headers, column_widths))

        # Print table header
        print(header_row)
        print("-" * len(header_row))

        # Print table content
        for idx, snapshot in enumerate(snapshot_info):

            row_data = [str(idx + 1), snapshot["provider"], snapshot["mirror"], snapshot["type"]]
            wrapped_data = [textwrap.fill(data, width=width) for data, width in zip(row_data, column_widths)]
            formatted_row = " | ".join(f"{data:{width}}" for data, width in zip(wrapped_data, column_widths))
            print(formatted_row)

        print()

    install_snapshot_prerequisites()
    snapshots = parse_snapshot_info(network)
    
    while True:

        print_snapshot_download_info(snapshots)
        choice = input("Enter your choice, or 'exit' to quit: ").strip()

        if choice.lower() == "exit":
            print("Exiting the program...")
            sys.exit(0)

        if int(choice) < 0 or int(choice) > len(snapshots):
            clear_screen()
            print(bcolors.RED + "Invalid input. Please choose a valid option." + bcolors.ENDC)
        else:
            break
    
    snapshot_url = snapshots[int(choice) - 1]['url']

    try:
        print(f"\n🔽 Downloading snapshots from {snapshot_url}")
        download_process = subprocess.Popen(["wget", "-q", "-O", "-", snapshot_url], stdout=subprocess.PIPE)
        lz4_process = subprocess.Popen(["lz4", "-d"], stdin=download_process.stdout, stdout=subprocess.PIPE)
        tar_process = subprocess.Popen(["tar", "-C", osmosis_home, "-xf", "-"], stdin=lz4_process.stdout, stdout=subprocess.PIPE)

        tar_process.wait()
        print("Snapshot download and extraction completed successfully.")

    except subprocess.CalledProcessError as e:
        print("Failed to download the snapshot.")
        print(f"Error: {e}")
        sys.exit(1)

    clear_screen()


def download_cosmovisor(osmosis_home):
    """
    Downloads and installs cosmovisor.

    Returns:
        use_cosmovisor(bool): Whether to use cosmovisor or not.

    """
    if not args.cosmovisor:
        print(bcolors.OKGREEN + f"""
Do you want to install cosmovisor?

    1) Yes, download and install cosmovisor (default)
    2) No

💡 You can specify the cosmovisor setup using the --cosmovisor flag.
""" + bcolors.ENDC)

        while True:
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice == Answer.YES:
                break
            elif choice == Answer.NO:
                print("Skipping cosmovisor installation.")
                clear_screen()
                return False
            else:
                print("Invalid choice. Please enter 1 or 2.")

    # Download and install cosmovisor
    operating_system = platform.system().lower()
    architecture = platform.machine()

    if architecture == "x86_64":
        architecture = "amd64"
    elif architecture == "aarch64":
        architecture = "arm64"

    if architecture not in ["arm64", "amd64"]:
        print(f"Unsupported architecture {architecture}.")
        sys.exit(1)
    
    if operating_system in COSMOVISOR_URL and architecture in COSMOVISOR_URL[operating_system]:
        binary_url = COSMOVISOR_URL[operating_system][architecture]
    else:
        print(f"Binary download URL not available for {os}/{architecture}")
        sys.exit(0)

    try:   
        binary_path = os.path.join(args.binary_path, "cosmovisor")

        print("Downloading " + bcolors.PURPLE+ "cosmovisor" + bcolors.ENDC, end="\n\n")
        print("from " + bcolors.OKGREEN + f"{binary_url}" + bcolors.ENDC, end=" ")
        print("to " + bcolors.OKGREEN + f"{binary_path}" + bcolors.ENDC)
        print()
        print(bcolors.OKGREEN + "💡 You can change the path using --binary_path" + bcolors.ENDC)

        clear_screen()
        temp_dir = tempfile.mkdtemp()
        temp_binary_path = os.path.join(temp_dir, "cosmovisor")

        subprocess.run(["wget", binary_url,"-q", "-O", temp_binary_path], check=True)
        os.chmod(temp_binary_path, 0o755)

        if platform.system() == "Linux":
            subprocess.run(["sudo", "mv", temp_binary_path, binary_path], check=True)
            subprocess.run(["sudo", "chown", f"{os.environ['USER']}:{os.environ['USER']}", binary_path], check=True)
            subprocess.run(["sudo", "chmod", "+x", binary_path], check=True)
        else:
            subprocess.run(["mv", temp_binary_path, binary_path], check=True)

        # Test binary 
        subprocess.run(["cosmovisor", "help"], check=True)

        print("Binary downloaded successfully.")

    except subprocess.CalledProcessError:
        print("Failed to download the binary.")
        sys.exit(1)

    clear_screen()

    # Initialize cosmovisor
    print("Setting up cosmovisor directory...")

    # Set environment variables
    env = {
        "DAEMON_NAME": "osmosisd",
        "DAEMON_HOME": osmosis_home
    }

    try:
        subprocess.run(["/usr/local/bin/cosmovisor", "init", "/usr/local/bin/osmosisd"], check=True, env=env)
    except subprocess.CalledProcessError:
        print("Failed to initialize cosmovisor.")
        sys.exit(1)

    clear_screen()
    return True


def setup_cosmovisor_service(osmosis_home):
    """
    Setup cosmovisor service on Linux.
    """

    operating_system = platform.system()

    if operating_system != "Linux":
        return False
    
    if not args.service:
        print(bcolors.OKGREEN + f"""
Do you want to setup cosmovisor as a background service?

    1) Yes, setup cosmovisor as a service
    2) No

💡 You can specify the service setup using the --service flag.
""" + bcolors.ENDC)

        while True:
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice == Answer.YES:
                break
            elif choice == Answer.NO:
                return
    
    user = os.environ.get("USER")
    
    unit_file_contents = f"""[Unit]
Description=Cosmovisor daemon
After=network-online.target

[Service]
Environment="DAEMON_NAME=osmosisd"
Environment="DAEMON_HOME={osmosis_home}"
Environment="DAEMON_RESTART_AFTER_UPGRADE=true"
Environment="DAEMON_ALLOW_DOWNLOAD_BINARIES=false"
Environment="DAEMON_LOG_BUFFER_SIZE=512"
Environment="UNSAFE_SKIP_BACKUP=true"
User={user}
ExecStart=/usr/local/bin/cosmovisor start --home {osmosis_home}
Restart=always
RestartSec=3
LimitNOFILE=infinity
LimitNPROC=infinity

[Install]
WantedBy=multi-user.target
"""

    unit_file_path = "/lib/systemd/system/cosmovisor.service"

    with open("cosmovisor.service", "w") as f:
        f.write(unit_file_contents)

    subprocess.run(["sudo", "mv", "cosmovisor.service", unit_file_path])
    subprocess.run(["sudo", "systemctl", "daemon-reload"])
    subprocess.run(["systemctl", "restart", "systemd-journald"])

    clear_screen()
    return True


def setup_osmosisd_service(osmosis_home):
    """
    Setup osmosisd service on Linux.
    """

    operating_system = platform.system()

    if operating_system != "Linux":
        return False

    if not args.service:
        print(bcolors.OKGREEN + """
Do you want to set up osmosisd as a background service?

    1) Yes, set up osmosisd as a service
    2) No

💡 You can specify the service setup using the --service flag.
""" + bcolors.ENDC)

        while True:
            choice = input("Enter your choice, or 'exit' to quit: ").strip()

            if choice.lower() == "exit":
                print("Exiting the program...")
                sys.exit(0)

            if choice == Answer.YES:
                break
            elif choice == Answer.NO:
                return
    
    user = os.environ.get("USER")
    
    unit_file_contents = f"""[Unit]
Description=Osmosis Daemon
After=network-online.target

[Service]
User={user}
ExecStart=/usr/local/bin/osmosisd start --home {osmosis_home}
Restart=always
RestartSec=3
LimitNOFILE=infinity
LimitNPROC=infinity

[Install]
WantedBy=multi-user.target
"""

    unit_file_path = "/lib/systemd/system/osmosisd.service"

    with open("osmosisd.service", "w") as f:
        f.write(unit_file_contents)

    subprocess.run(["sudo", "mv", "osmosisd.service", unit_file_path])
    subprocess.run(["sudo", "systemctl", "daemon-reload"])
    subprocess.run(["systemctl", "restart", "systemd-journald"])

    clear_screen()
    return True


def main():

    welcome_message()

    # Start the installation
    chosen_install = select_install()

    if chosen_install == InstallChoice.NODE:
        network = select_network()
        download_binary(network)
        osmosis_home = select_osmosis_home()
        moniker = select_moniker()
        initialize_osmosis_home(osmosis_home, moniker)
        using_cosmovisor = download_cosmovisor(osmosis_home)
        download_genesis(network, osmosis_home)
        download_addrbook(network, osmosis_home)
        select_pruning(osmosis_home)
        download_snapshot(network, osmosis_home)
        if using_cosmovisor:
            using_service = setup_cosmovisor_service(osmosis_home)
        else:
            using_service = setup_osmosisd_service(osmosis_home)
        node_complete_message(using_cosmovisor, using_service, osmosis_home)

    elif chosen_install == InstallChoice.CLIENT:
        network = select_network()
        download_binary(network)
        osmosis_home = select_osmosis_home()
        moniker = select_moniker()
        initialize_osmosis_home(osmosis_home, moniker)
        customize_config(osmosis_home, network)
        client_complete_message(osmosis_home)

    elif chosen_install == InstallChoice.LOCALOSMOSIS:
        print("Setting up a LocalOsmosis node not yet supported.")
        sys.exit(1)

main()
