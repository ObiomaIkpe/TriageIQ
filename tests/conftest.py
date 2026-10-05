import os

# Set dummy keys before any app module is imported, so importing the graph
# modules never needs real credentials and tests never hit the network.
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")
os.environ.setdefault("VOYAGE_API_KEY", "test-key")