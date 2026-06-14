import sys
import os
import importlib.util

# Paths
ui_file_path = "/Users/nirvankura/Downloads/SemiAutomaticClassificationPlugin/ui/ui_semiautomaticclassificationplugin_dock_class_simplified.py"
plugin_dir = "/Users/nirvankura/Downloads/SemiAutomaticClassificationPlugin"

# Add directories to system path just in case
sys.path.append(plugin_dir)
sys.path.append(os.path.dirname(ui_file_path))

try:
    # Dynamically load the module to avoid macOS sandbox listdir PermissionError
    spec = importlib.util.spec_from_file_location("ui_semiautomaticclassificationplugin_dock_class_simplified", ui_file_path)
    ui_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ui_module)
    Ui_DockClassSimplified = ui_module.Ui_DockClassSimplified
except Exception as e:
    print(f"Error dynamically loading UI file: {e}")
    sys.exit(1)

from PyQt6 import QtWidgets, QtCore

class StandaloneDockWidget(QtWidgets.QDockWidget):
    def __init__(self):
        super().__init__()
        self.ui = Ui_DockClassSimplified()
        self.ui.setupUi(self)
        self.setWindowTitle("SCP Dock - Preview")
        self.setAttribute(QtCore.Qt.WidgetAttribute.WA_DeleteOnClose)

def main():
    app = QtWidgets.QApplication(sys.argv)
    app.setStyle('Fusion')
    
    window = StandaloneDockWidget()
    window.resize(450, 700)
    window.show()
    
    print("UI window launched successfully. Close the window to exit.")
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
