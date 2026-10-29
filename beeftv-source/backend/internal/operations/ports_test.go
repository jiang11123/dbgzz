package operations

import (
	"reflect"
	"strings"
	"testing"
)

func TestDomainMethodsDoNotExposeGormOrApp(t *testing.T) {
	var probe Domain
	iface := reflect.TypeOf(&probe).Elem()
	for i := 0; i < iface.NumMethod(); i++ {
		method := iface.Method(i)
		for j := 0; j < method.Type.NumIn(); j++ {
			name := method.Type.In(j).String()
			if strings.Contains(name, "gorm") {
				t.Fatalf("%s still takes %s", method.Name, name)
			}
			if strings.Contains(name, "internal/app") {
				t.Fatalf("%s still takes app type %s", method.Name, name)
			}
		}
		for j := 0; j < method.Type.NumOut(); j++ {
			name := method.Type.Out(j).String()
			if strings.Contains(name, "gorm") {
				t.Fatalf("%s still returns %s", method.Name, name)
			}
			if strings.Contains(name, "internal/app") {
				t.Fatalf("%s still returns app type %s", method.Name, name)
			}
		}
	}
}
